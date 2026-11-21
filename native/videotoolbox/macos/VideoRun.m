#import "VideoRun.h"
#import <VideoToolbox/VideoToolbox.h>
#import <CoreImage/CoreImage.h>
#import <Metal/Metal.h>
#import <math.h>

static const size_t Width = 1280, Height = 720;

@implementation KPVideoRun {
    CAMetalLayer *_layer;
    id<MTLCommandQueue> _commands;
    CIContext *_ci;
    CGColorSpaceRef _srgb;
    VTFrameProcessor *_processor;
    VTLowLatencyFrameInterpolationConfiguration *_cfg;
    dispatch_queue_t _worker, _presentation;
    dispatch_semaphore_t _slots, _outputSlots;
    CVPixelBufferRef _previous;
    BOOL _useVT, _closed;
    double _firstPTS, _lastPTS, _anchor;
    NSMutableArray<NSArray<NSNumber *> *> *_times;
    NSUInteger _input, _queueDrops, _outputDrops, _late, _submitted, _sourceGaps;
    NSString *_error;
}

- (instancetype)initWithLayer:(CAMetalLayer *)layer useVT:(BOOL)useVT {
    if ((self = [super init])) {
        _layer = layer; _useVT = useVT;
        _worker = dispatch_queue_create("org.kittyplays.probe.video", DISPATCH_QUEUE_SERIAL);
        _presentation = dispatch_queue_create("org.kittyplays.probe.presentation", DISPATCH_QUEUE_SERIAL);
        _slots = dispatch_semaphore_create(6);
        _outputSlots = dispatch_semaphore_create(18);
        _commands = [layer.device newCommandQueue];
        _ci = [CIContext contextWithMTLDevice:layer.device];
        _srgb = CGColorSpaceCreateWithName(kCGColorSpaceSRGB);
        _times = [NSMutableArray array];
        if (useVT) {
            if (![VTLowLatencyFrameInterpolationConfiguration isSupported]) return nil;
            _cfg = [[VTLowLatencyFrameInterpolationConfiguration alloc] initWithFrameWidth:Width frameHeight:Height numberOfInterpolatedFrames:1];
            _processor = [VTFrameProcessor new];
            NSError *error = nil;
            if (!_cfg || ![_processor startSessionWithConfiguration:_cfg error:&error]) return nil;
        }
    }
    return self;
}

- (CVPixelBufferRef)makeBuffer:(NSData *)data full:(BOOL)full {
    CVPixelBufferRef b = NULL;
    NSDictionary *attrs = data ? _cfg.sourcePixelBufferAttributes : _cfg.destinationPixelBufferAttributes;
    attrs = attrs ?: @{(id)kCVPixelBufferIOSurfacePropertiesKey:@{}};
    if (CVPixelBufferCreate(NULL, Width, Height, kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange,
                            (__bridge CFDictionaryRef)attrs, &b) != kCVReturnSuccess) return NULL;
    if (data) {
        if (data.length != Width*Height*3/2 || CVPixelBufferLockBaseAddress(b, 0) != kCVReturnSuccess) {
            CVPixelBufferRelease(b); return NULL;
        }
        const uint8_t *p = data.bytes;
        for (size_t plane=0; plane<2; plane++) {
            size_t rows = plane ? Height/2 : Height, stride = CVPixelBufferGetBytesPerRowOfPlane(b, plane);
            uint8_t *dst = CVPixelBufferGetBaseAddressOfPlane(b, plane);
            for (size_t row=0; row<rows; row++, p+=Width, dst+=stride) {
                if (!full) memcpy(dst,p,Width);
                else for (size_t x=0; x<Width; x++) dst[x] = 16+(p[x]*(plane ? 224 : 219)+127)/255;
            }
        }
        CVPixelBufferUnlockBaseAddress(b, 0);
    }
    CVBufferSetAttachment(b,kCVImageBufferColorPrimariesKey,kCVImageBufferColorPrimaries_ITU_R_709_2,kCVAttachmentMode_ShouldPropagate);
    CVBufferSetAttachment(b,kCVImageBufferTransferFunctionKey,kCVImageBufferTransferFunction_ITU_R_709_2,kCVAttachmentMode_ShouldPropagate);
    CVBufferSetAttachment(b,kCVImageBufferYCbCrMatrixKey,kCVImageBufferYCbCrMatrix_ITU_R_709_2,kCVAttachmentMode_ShouldPropagate);
    return b;
}

- (void)present:(CVPixelBufferRef)b pts:(double)pts generated:(BOOL)synthetic {
    double target = _anchor + pts - _firstPTS;
    if (dispatch_semaphore_wait(_outputSlots, DISPATCH_TIME_NOW)) {
        @synchronized(self) { _outputDrops++; } return;
    }
    CVPixelBufferRetain(b);
    dispatch_async(_presentation, ^{ @autoreleasepool {
        double wait = target - CACurrentMediaTime() - .018;
        if (wait > 0) [NSThread sleepForTimeInterval:wait];
        [self submit:b target:target generated:synthetic];
        CVPixelBufferRelease(b);
        dispatch_semaphore_signal(self->_outputSlots);
    }});
}

// WebKit's SDR reference is already in sRGB. Compare both interpretations of
// the copied NV12 bytes through the same colour pipeline used for presentation.
- (NSDictionary *)rangeForPacket:(NSString *)packet samples:(NSArray *)samples reportedFull:(BOOL)reportedFull {
    if (packet.length != Width*Height*2 || samples.count < 8 || samples.count > 256) return nil;
    for (id point in samples) {
        if (![point isKindOfClass:NSArray.class] || [point count]!=5) return nil;
        for (id value in point) if (![value isKindOfClass:NSNumber.class]) return nil;
        if ([point[0] unsignedIntegerValue]>=Width || [point[1] unsignedIntegerValue]>=Height) return nil;
        for (int k=2; k<5; ++k) if ([point[k] unsignedIntegerValue]>255) return nil;
    }
    NSData *bytes=[[NSData alloc] initWithBase64EncodedString:packet options:0];
    if (bytes.length!=Width*Height*3/2) return nil;
    NSMutableData *raster=[NSMutableData dataWithLength:Width*Height*4];
    double scores[2]={0,0};
    for (int full=0; full<=1; ++full) {
        CVPixelBufferRef buf=[self makeBuffer:bytes full:full];
        if (!buf) return nil;
        [_ci render:[CIImage imageWithCVPixelBuffer:buf] toBitmap:raster.mutableBytes rowBytes:Width*4
                bounds:CGRectMake(0,0,Width,Height) format:kCIFormatRGBA8 colorSpace:_srgb];
        CVPixelBufferRelease(buf);
        const uint8_t *rgb=raster.bytes;
        for (NSArray *point in samples) {
            NSUInteger p=4*([point[1] unsignedIntegerValue]*Width+[point[0] unsignedIntegerValue]);
            for (int k=0; k<3; ++k)
                scores[full]+=MIN(32,labs((long)rgb[p+k]-[point[k+2] integerValue]));
        }
        scores[full]/=(3*samples.count);
    }
    BOOL confident=fabs(scores[0]-scores[1])>1 && MIN(scores[0],scores[1])<12;
    BOOL full=fabs(scores[0]-scores[1])<.1 ? reportedFull : scores[1]<scores[0];
    return @{@"fullRange":@(full), @"confident":@(confident), @"limitedError":@(scores[0]), @"fullError":@(scores[1])};
}
- (void)submit:(CVPixelBufferRef)b target:(double)target generated:(BOOL)synthetic {
    if (CACurrentMediaTime() > target) { @synchronized(self) { _late++; } return; }
    id<CAMetalDrawable> surface = [_layer nextDrawable];
    if (!surface) return;
    id<MTLCommandBuffer> command = [_commands commandBuffer];
    [_ci render:[CIImage imageWithCVPixelBuffer:b] toMTLTexture:surface.texture commandBuffer:command
         bounds:CGRectMake(0,0,Width,Height) colorSpace:_srgb];
    [surface addPresentedHandler:^(id<MTLDrawable> item) {
        if (item.presentedTime > 0) @synchronized(self) {
            [self->_times addObject:@[@(item.presentedTime), @(synthetic)]];
        }
    }];
    [command presentDrawable:surface atTime:target];
    [command commit];
    @synchronized(self) { _submitted++; }
}

static VTFrameProcessorFrame *Frame(CVPixelBufferRef buffer, double pts) {
    return [[VTFrameProcessorFrame alloc] initWithBuffer:buffer presentationTimeStamp:CMTimeMakeWithSeconds(pts,60000)];
}

- (BOOL)offer:(NSString *)base64 pts:(double)pts full:(BOOL)full {
    if (base64.length != Width*Height*2 || !isfinite(pts)) return NO;
    @synchronized(self) { if (_closed || _error) return NO; }
    if (dispatch_semaphore_wait(_slots, DISPATCH_TIME_NOW)) {
        @synchronized(self) { _queueDrops++; } return NO;
    }
    CFTimeInterval arrived = CACurrentMediaTime();
    dispatch_async(_worker, ^{ @autoreleasepool {
        NSData *data = [[NSData alloc] initWithBase64EncodedString:base64 options:0];
        CVPixelBufferRef cur = data ? [self makeBuffer:data full:full] : NULL;
        if (cur && (!self->_previous || pts > self->_lastPTS)) {
            double delta = pts - self->_lastPTS;
            if (!self->_previous) { self->_anchor = arrived + .085; self->_firstPTS = pts; }
            else if (delta < .012 || delta > .022) { @synchronized(self) { self->_sourceGaps++; } }
            else if (self->_useVT) {
                double middle = pts-delta*.5;
                CVPixelBufferRef dest = [self makeBuffer:nil full:NO];
                if (dest) {
                    VTLowLatencyFrameInterpolationParameters *params = [[VTLowLatencyFrameInterpolationParameters alloc]
                        initWithSourceFrame:Frame(cur,pts) previousFrame:Frame(self->_previous,self->_lastPTS)
                        interpolationPhase:@[@0.5f] destinationFrames:@[Frame(dest,middle)]];
                    NSError *error = nil;
                    if (params && [self->_processor processWithParameters:params error:&error])
                        [self present:dest pts:middle generated:YES];
                    else @synchronized(self) { self->_error = error.localizedDescription ?: @"VT parameters"; }
                    CVPixelBufferRelease(dest);
                }
            }
            [self present:cur pts:pts generated:NO];
            if (self->_previous) CVPixelBufferRelease(self->_previous);
            self->_previous = cur; self->_lastPTS = pts;
            @synchronized(self) { self->_input++; }
        } else if (cur) CVPixelBufferRelease(cur);
        dispatch_semaphore_signal(self->_slots);
    }});
    return YES;
}

- (NSDictionary *)report {
    @synchronized(self) {
        NSArray *times = [_times sortedArrayUsingComparator:^NSComparisonResult(NSArray *a, NSArray *b) {
            return [a[0] compare:b[0]];
        }];
        double span = [times.lastObject[0] doubleValue] - [times.firstObject[0] doubleValue];
        NSUInteger gen = 0;
        double worst = 0, prev = 0;
        NSMutableArray<NSNumber *> *gaps = [NSMutableArray array];
        for (NSArray *item in times) {
            double t=[item[0] doubleValue]; if(prev) {
                double gap=(t-prev)*1000; worst=MAX(worst,gap); [gaps addObject:@(gap)];
            }
            prev=t; gen += [item[1] boolValue];
        }
        [gaps sortUsingSelector:@selector(compare:)];
        return @{@"framesIn":@(_input), @"shown":@(times.count), @"generatedShown":@(gen),
                 @"fps":@(span>0 ? (times.count-1)/span : 0), @"maxGapMs":@(worst),
                 @"p99GapMs":gaps.count ? gaps[(NSUInteger)ceil(.99*gaps.count)-1] : NSNull.null,
                 @"bridgeQueueDrops":@(_queueDrops), @"outputQueueDrops":@(_outputDrops), @"skippedLate":@(_late), @"sourceGaps":@(_sourceGaps),
                 @"submitted":@(_submitted), @"error":_error ?: NSNull.null};
    }
}
- (void)finish:(void (^)(NSDictionary *))completion {
    @synchronized(self) { if (_closed) return; _closed=YES; }
    dispatch_async(_worker, ^{
        [self->_processor endSession];
        dispatch_async(self->_presentation, ^{
            double deadline = CACurrentMediaTime() + 1.0;
            while (CACurrentMediaTime() < deadline) {
                @synchronized(self) { if (self->_times.count >= self->_submitted) break; }
                [NSThread sleepForTimeInterval:.01];
            }
            NSDictionary *summary = [self report];
            dispatch_async(dispatch_get_main_queue(), ^{ completion(summary); });
        });
    });
}
- (void)dealloc {
    if (_previous) CVPixelBufferRelease(_previous);
    if (_srgb) CGColorSpaceRelease(_srgb);
}
@end
