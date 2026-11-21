#import <AppKit/AppKit.h>
#import <CoreGraphics/CoreGraphics.h>
#import <Metal/Metal.h>
#import <WebKit/WebKit.h>
#import "VideoRun.h"

static BOOL allowed(NSString *host) {
    return [host isEqualToString:@"www.youtube.com"] || [host isEqualToString:@"m.youtube.com"];
}

@interface Bench : NSObject <NSApplicationDelegate, NSWindowDelegate, WKScriptMessageHandlerWithReply>
@end

@implementation Bench {
    NSWindow *_window;
    WKWebView *_web;
    NSView *_surface;
    CAMetalLayer *_layer;
    NSButton *_start, *_copy;
    NSPopUpButton *_mode;
    NSTextField *_status;
    KPVideoRun *_run;
    NSArray<NSString *> *_modes;
    NSDictionary *_result;
    BOOL _running, _automated;
    NSInteger _seconds;
    double _startTime;
    NSString *_script;
    NSString *_token;
    BOOL _capturing;
    CFTimeInterval _hiddenSince, _hiddenSeconds;
}

- (void)applicationDidFinishLaunching:(NSNotification *)note {
    NSUserDefaults *args = NSUserDefaults.standardUserDefaults;
    _automated = [args boolForKey:@"bench-auto"];
    _seconds = [args objectForKey:@"bench-seconds"] ? [args integerForKey:@"bench-seconds"] : 60;
    _startTime = [args objectForKey:@"bench-start"] ? [args doubleForKey:@"bench-start"] : 4;
    _modes = @[@"source", @"original", @"vt"];
    NSString *mode = [args stringForKey:@"bench-mode"] ?: @"vt";
    if (![_modes containsObject:mode] || _seconds < 1 || _seconds > 600 || !isfinite(_startTime) || _startTime < 0) {
        fprintf(stderr, "Invalid benchmark arguments\n");
        [NSApp terminate:nil]; return;
    }
    NSScreen *screen = NSScreen.mainScreen;
    for (NSScreen *candidate in NSScreen.screens) {
        CGDirectDisplayID number = [candidate.deviceDescription[@"NSScreenNumber"] unsignedIntValue];
        if (!CGDisplayIsBuiltin(number)) { screen = candidate; break; }
    }
    NSRect visible = screen.visibleFrame;
    CGFloat w=MIN(1680,visible.size.width-60), h=MIN(660,visible.size.height-70);
    NSRect rect=NSMakeRect(NSMidX(visible)-w/2,NSMidY(visible)-h/2,w,h);
    _window=[[NSWindow alloc] initWithContentRect:rect styleMask:NSWindowStyleMaskTitled|NSWindowStyleMaskClosable|NSWindowStyleMaskResizable|NSWindowStyleMaskMiniaturizable backing:NSBackingStoreBuffered defer:NO];
    _window.delegate=self;
    if (_automated) {
        _window.collectionBehavior=NSWindowCollectionBehaviorCanJoinAllSpaces | NSWindowCollectionBehaviorFullScreenAuxiliary;
        _window.level=NSFloatingWindowLevel;
    }
    _window.title=@"KittyPlays · Тест интерполяции для macOS";
    _window.minSize=NSMakeSize(700,390);
    NSView *root=_window.contentView;
    WKWebViewConfiguration *cfg=[WKWebViewConfiguration new];
    cfg.websiteDataStore=WKWebsiteDataStore.nonPersistentDataStore;
    cfg.mediaTypesRequiringUserActionForPlayback=WKAudiovisualMediaTypeNone;
    [cfg.userContentController addScriptMessageHandlerWithReply:self contentWorld:WKContentWorld.pageWorld name:@"framePort"];
    [cfg.userContentController addScriptMessageHandlerWithReply:self contentWorld:WKContentWorld.pageWorld name:@"rangePort"];
    [cfg.userContentController addScriptMessageHandlerWithReply:self contentWorld:WKContentWorld.pageWorld name:@"benchResult"];
    _web=[[WKWebView alloc] initWithFrame:NSZeroRect configuration:cfg];
    NSString *version=[NSBundle bundleWithPath:@"/Applications/Safari.app"].infoDictionary[@"CFBundleShortVersionString"];
    if (version) _web.customUserAgent=[NSString stringWithFormat:@"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/%@ Safari/605.1.15",version];
    NSView *surface=[NSView new];
    _surface=surface;
    _layer=[CAMetalLayer layer]; _layer.device=MTLCreateSystemDefaultDevice();
    _layer.pixelFormat=MTLPixelFormatBGRA8Unorm; _layer.framebufferOnly=NO;
    _layer.displaySyncEnabled=YES;
    CGColorSpaceRef srgb=CGColorSpaceCreateWithName(kCGColorSpaceSRGB); _layer.colorspace=srgb; CGColorSpaceRelease(srgb);
    surface.wantsLayer=YES; surface.layer=_layer;
    _mode=[NSPopUpButton new];
    [_mode addItemsWithTitles:@[@"Источник WebKit", @"Original через Metal", @"VideoToolbox 2×"]];
    [_mode selectItemAtIndex:[_modes indexOfObject:mode]];
    _start=[NSButton buttonWithTitle:@"Запустить замер" target:self action:@selector(start:)];
    _copy=[NSButton buttonWithTitle:@"Скопировать JSON" target:self action:@selector(copyResult:)];
    _copy.enabled=NO;
    _status=[NSTextField wrappingLabelWithString:@"Откройте ролик YouTube и запустите замер. Поток для сравнения — 720p60 SDR."];
    NSStackView *controls=[NSStackView stackViewWithViews:@[_mode,_start,_copy]];
    controls.orientation=NSUserInterfaceLayoutOrientationHorizontal;
    for(NSView *v in @[_web,surface,controls,_status]) { v.translatesAutoresizingMaskIntoConstraints=NO; [root addSubview:v]; }
    [NSLayoutConstraint activateConstraints:@[
        [controls.topAnchor constraintEqualToAnchor:root.topAnchor constant:10],
        [controls.leadingAnchor constraintEqualToAnchor:root.leadingAnchor constant:12],
        [_status.topAnchor constraintEqualToAnchor:controls.bottomAnchor constant:6],
        [_status.leadingAnchor constraintEqualToAnchor:controls.leadingAnchor],
        [_status.trailingAnchor constraintEqualToAnchor:root.trailingAnchor constant:-12],
        [_web.topAnchor constraintEqualToAnchor:_status.bottomAnchor constant:8],
        [_web.bottomAnchor constraintEqualToAnchor:root.bottomAnchor], [_web.leadingAnchor constraintEqualToAnchor:root.leadingAnchor],
        [_web.widthAnchor constraintEqualToAnchor:root.widthAnchor multiplier:.5],
        [surface.centerYAnchor constraintEqualToAnchor:_web.centerYAnchor],
        [surface.leadingAnchor constraintEqualToAnchor:_web.trailingAnchor], [surface.trailingAnchor constraintEqualToAnchor:root.trailingAnchor],
        [surface.heightAnchor constraintEqualToAnchor:surface.widthAnchor multiplier:9.0/16.0]
    ]];
    NSURL *js=[NSBundle.mainBundle URLForResource:@"webkit_capture" withExtension:@"js"];
    _script=[NSString stringWithContentsOfURL:js encoding:NSUTF8StringEncoding error:nil];
    [_web loadRequest:[NSURLRequest requestWithURL:[NSURL URLWithString:@"https://www.youtube.com/watch?v=Yx4co6X0MUg"]]];
    [_window makeKeyAndOrderFront:nil]; [NSApp activateIgnoringOtherApps:YES];
    if (_automated) [self startWhenReadyUntil:CACurrentMediaTime()+55];
}

- (void)startWhenReadyUntil:(double)deadline {
    if (CACurrentMediaTime() > deadline) { [self complete:@{@"error":@"Main YouTube video did not load"}]; return; }
    [_web evaluateJavaScript:@"location.pathname==='/watch' && document.querySelector('video')?.videoWidth>0" completionHandler:^(id value,NSError *error) {
        if ([value isKindOfClass:NSNumber.class] && [value boolValue]) [self start:nil];
        else dispatch_after(dispatch_time(DISPATCH_TIME_NOW,NSEC_PER_SEC/2),dispatch_get_main_queue(),^{ [self startWhenReadyUntil:deadline]; });
    }];
}

- (void)start:(id)sender {
    if (_running) return;
    [_window makeKeyAndOrderFront:nil];
    [_window orderFrontRegardless];
    NSURLComponents *url=[NSURLComponents componentsWithURL:_web.URL ?: [NSURL URLWithString:@"about:blank"] resolvingAgainstBaseURL:NO];
    NSString *videoID=nil;
    for (NSURLQueryItem *item in url.queryItems) if ([item.name isEqualToString:@"v"]) videoID=item.value;
    NSString *mode=_modes[_mode.indexOfSelectedItem];
    if (!allowed(url.host) || ![url.path isEqualToString:@"/watch"] || !videoID.length || !_script) {
        [self complete:@{@"error":@"Откройте страницу выбранного ролика YouTube."}]; return;
    }
    BOOL sourceOnly=[mode isEqualToString:@"source"];
    _surface.hidden=sourceOnly;
    _layer.drawableSize=CGSizeMake(1280,720);
    if (!sourceOnly) {
        _run=[[KPVideoRun alloc] initWithLayer:_layer useVT:[mode isEqualToString:@"vt"]];
        if (!_run) { [self complete:@{@"error":@"Не удалось открыть обработчик для этого GPU."}]; return; }
    }
    _running=YES; _start.enabled=NO; _mode.enabled=NO; _copy.enabled=NO;
    _status.stringValue=[NSString stringWithFormat:@"Ожидание потока 720p60 SDR и замер длительностью %ld с…",(long)_seconds];
    NSDictionary *options=@{@"seconds":@(_seconds),@"start":@(_startTime),@"videoId":videoID,@"sourceOnly":@(sourceOnly)};
    NSString *encoded=[[NSString alloc] initWithData:[NSJSONSerialization dataWithJSONObject:options options:0 error:nil] encoding:NSUTF8StringEncoding];
    _token=NSUUID.UUID.UUIDString;
    _capturing=NO;
    NSString *body=[NSString stringWithFormat:@"(()=>{const id='%@';if(window.__kittyBench===id)return;window.__kittyBench=id;const port=window.webkit.messageHandlers.benchResult;const rows=[];const report=r=>{rows.push(r);if(r.event==='captureStart')port.postMessage([id,'started']);};\n%@\ncaptureKittyFrames(%@,report).then(()=>port.postMessage([id,JSON.stringify({rows})])).catch(e=>port.postMessage([id,JSON.stringify({rows,error:String(e)})]));})()",_token,_script,encoded];
    [self ensureScript:body token:_token deadline:CACurrentMediaTime()+_seconds+125];
}

- (void)ensureScript:(NSString *)script token:(NSString *)token deadline:(double)deadline {
    if(![_token isEqual:token]) return;
    if(CACurrentMediaTime()>deadline) { [self finishRows:nil error:@"Истекло время ожидания видео или результата."]; return; }
    // YouTube can replace the initial document before playback starts.
    if(!_capturing && allowed(_web.URL.host) && [_web.URL.path isEqual:@"/watch"]) {
        [_web evaluateJavaScript:script completionHandler:^(id value,NSError *e) {
            if (e && [self->_token isEqual:token] && e.code==WKErrorJavaScriptExceptionOccurred)
                [self finishRows:nil error:e.userInfo[@"WKJavaScriptExceptionMessage"] ?: e.localizedDescription];
        }];
    }
    dispatch_after(dispatch_time(DISPATCH_TIME_NOW,NSEC_PER_SEC),dispatch_get_main_queue(),^{
        [self ensureScript:script token:token deadline:deadline];
    });
}

- (void)windowDidChangeOcclusionState:(NSNotification *)note {
    if (!_capturing) return;
    BOOL visible=(_window.occlusionState & NSWindowOcclusionStateVisible)!=0;
    if (!visible && !_hiddenSince) _hiddenSince=CACurrentMediaTime();
    if (visible && _hiddenSince) {
        _hiddenSeconds+=CACurrentMediaTime()-_hiddenSince;
        _hiddenSince=0;
    }
}

- (void)finishRows:(NSArray *)rows error:(NSString *)error {
        _token=nil;
        if (_hiddenSince) _hiddenSeconds+=CACurrentMediaTime()-_hiddenSince;
        _hiddenSince=0;
        _capturing=NO;
        NSMutableDictionary *result=[@{@"mode":_modes[_mode.indexOfSelectedItem], @"seconds":@(_seconds), @"web":rows?:@[]} mutableCopy];
        NSScreen *screen=self->_window.screen;
        CGDirectDisplayID number=[screen.deviceDescription[@"NSScreenNumber"] unsignedIntValue];
        CGDisplayModeRef display=CGDisplayCopyDisplayMode(number);
        result[@"display"]=screen.localizedName ?: @"";
        result[@"windowVisibleAtEnd"]=@((self->_window.occlusionState & NSWindowOcclusionStateVisible)!=0);
        result[@"windowHiddenSeconds"]=@(_hiddenSeconds);
        result[@"displayHz"]=@(display ? CGDisplayModeGetRefreshRate(display) : 0);
        if(display) CGDisplayModeRelease(display);
        if(error) result[@"error"]=error;
        if(self->_run) [self->_run finish:^(NSDictionary *metal) {
            result[@"metal"]=metal; self->_run=nil; [self complete:result];
        }];
        else [self complete:result];
}

- (void)complete:(NSDictionary *)result {
    _running=NO; _start.enabled=YES; _mode.enabled=YES; _copy.enabled=YES;
    NSDictionary *metal=result[@"metal"], *web=[result[@"web"] lastObject];
    NSString *error=result[@"error"];
    if (!error && [metal[@"error"] isKindOfClass:NSString.class]) error=metal[@"error"];
    if (!error && ![web[@"callbacks"] unsignedIntegerValue]) error=@"Не получены кадры целевого потока.";
    if (!error && metal && ![metal[@"shown"] unsignedIntegerValue]) error=@"Metal не подтвердил показ.";
    if (!error && (![result[@"windowVisibleAtEnd"] boolValue] || [result[@"windowHiddenSeconds"] doubleValue]>0))
        error=@"Во время замера окно было скрыто.";
    double span=[web[@"latestTime"] doubleValue]-[web[@"firstTime"] doubleValue];
    BOOL complete=!error && span>=_seconds-.25 && span<=_seconds+.25 &&
        ![web[@"invalid"] unsignedIntegerValue] && ![web[@"failures"] unsignedIntegerValue];
    NSMutableDictionary *checked=[result mutableCopy];
    checked[@"completeSample"]=@(complete);
    checked[@"sourceSpanSeconds"]=@(span);
    if(error) checked[@"error"]=error;
    _result=[checked copy];
    if (error) _status.stringValue=error;
    else if (metal) _status.stringValue=[NSString stringWithFormat:@"Metal %.1f FPS · %@ показов · %@ сгенерировано · p99 %.1f мс", [metal[@"fps"] doubleValue],metal[@"shown"],metal[@"generatedShown"],[metal[@"p99GapMs"] isKindOfClass:NSNumber.class] ? [metal[@"p99GapMs"] doubleValue] : 0];
    else _status.stringValue=[NSString stringWithFormat:@"WebKit передал %@ уведомлений о кадрах за %.1f с.",web[@"callbacks"],[web[@"seconds"] doubleValue]];
    if(!error && !complete) _status.stringValue=[@"Неполный замер · " stringByAppendingString:_status.stringValue];
    if (_automated) {
        NSData *json=[NSJSONSerialization dataWithJSONObject:_result options:0 error:nil];
        fwrite(json.bytes,1,json.length,stdout); fputc('\n',stdout); fflush(stdout);
        if(error) exit(EXIT_FAILURE);
        [NSApp terminate:nil];
    }
}

- (void)copyResult:(id)sender {
    NSData *json=[NSJSONSerialization dataWithJSONObject:_result options:NSJSONWritingPrettyPrinted error:nil];
    [NSPasteboard.generalPasteboard clearContents];
    [NSPasteboard.generalPasteboard setString:[[NSString alloc] initWithData:json encoding:NSUTF8StringEncoding] forType:NSPasteboardTypeString];
}

- (void)userContentController:(WKUserContentController *)controller didReceiveScriptMessage:(WKScriptMessage *)message replyHandler:(void (^)(id,NSString *))reply {
    WKSecurityOrigin *origin=message.frameInfo.securityOrigin;
    NSArray *packet=message.body;
    if (!_running || !message.frameInfo.isMainFrame || ![origin.protocol isEqualToString:@"https"] ||
        !allowed(origin.host) || ![packet isKindOfClass:NSArray.class]) { reply(nil,@"Invalid sender"); return; }
    if ([message.name isEqual:@"benchResult"]) {
        if (packet.count!=2 || ![_token isEqual:packet[0]] || ![packet[1] isKindOfClass:NSString.class]) { reply(nil,@"Invalid run"); return; }
        reply(@YES,nil);
        if ([packet[1] isEqual:@"started"]) {
            _capturing=YES; _hiddenSeconds=0; _hiddenSince=0;
            [self windowDidChangeOcclusionState:nil];
            return;
        }
        NSDictionary *payload=[NSJSONSerialization JSONObjectWithData:[packet[1] dataUsingEncoding:NSUTF8StringEncoding] options:0 error:nil];
        [self finishRows:payload[@"rows"] error:payload[@"error"]]; return;
    }
    if ([message.name isEqual:@"rangePort"]) {
        if(!_run || packet.count!=3 || ![packet[0] isKindOfClass:NSString.class] || ![packet[1] isKindOfClass:NSArray.class] || ![packet[2] isKindOfClass:NSNumber.class]) {
            reply(nil,@"Invalid range sample"); return;
        }
        KPVideoRun *run=_run;
        dispatch_async(dispatch_get_global_queue(QOS_CLASS_USER_INITIATED,0),^{
            NSDictionary *choice=[run rangeForPacket:packet[0] samples:packet[1] reportedFull:[packet[2] boolValue]];
            dispatch_async(dispatch_get_main_queue(),^{ reply(choice,choice ? nil : @"Invalid calibration data"); });
        });
        return;
    }
    if (!_run || packet.count!=3 ||
        ![packet[0] isKindOfClass:NSNumber.class] || ![packet[1] isKindOfClass:NSNumber.class] || ![packet[2] isKindOfClass:NSString.class]) {
        reply(nil,@"Invalid frame packet"); return;
    }
    reply(@([_run offer:packet[2] pts:[packet[0] doubleValue] full:[packet[1] boolValue]]),nil);
}

- (BOOL)applicationShouldTerminateAfterLastWindowClosed:(NSApplication *)app { return YES; }
@end

int main(void) {
    @autoreleasepool {
        NSApplication *app=NSApplication.sharedApplication;
        [app setActivationPolicy:NSApplicationActivationPolicyRegular];
        NSMenu *menu=[NSMenu new]; NSMenuItem *item=[NSMenuItem new];
        [menu addItem:item]; NSMenu *appMenu=[NSMenu new]; item.submenu=appMenu;
        [appMenu addItemWithTitle:@"Завершить KittyPlays Bench" action:@selector(terminate:) keyEquivalent:@"q"];
        app.mainMenu=menu;
        Bench *delegate=[Bench new]; app.delegate=delegate; [app run];
        (void)delegate;
    }
    return 0;
}
