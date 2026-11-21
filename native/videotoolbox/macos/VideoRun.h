#import <Foundation/Foundation.h>
#import <QuartzCore/CAMetalLayer.h>

@interface KPVideoRun : NSObject
- (instancetype)initWithLayer:(CAMetalLayer *)layer useVT:(BOOL)useVT;
- (BOOL)offer:(NSString *)base64 pts:(double)pts full:(BOOL)full;
- (NSDictionary *)rangeForPacket:(NSString *)packet samples:(NSArray *)samples reportedFull:(BOOL)reportedFull;
- (NSDictionary *)report;
- (void)finish:(void (^)(NSDictionary *summary))completion;
@end
