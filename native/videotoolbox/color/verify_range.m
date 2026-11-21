#import "../macos/VideoRun.h"
#import <Metal/Metal.h>

// Drive the range decision from the macOS application using paired binary fixtures.
int main(int argc, const char **argv) {
    @autoreleasepool {
        if (argc != 4) return 2;
        NSString *packetPath=[NSString stringWithUTF8String:argv[1]];
        NSData *packet=[NSData dataWithContentsOfFile:packetPath];
        NSData *json=[NSData dataWithContentsOfFile:[NSString stringWithUTF8String:argv[2]]];
        if (!packet || !json) return 3;
        NSArray *points=[NSJSONSerialization JSONObjectWithData:json options:0 error:nil];
        CAMetalLayer *layer=[CAMetalLayer layer];
        layer.device=MTLCreateSystemDefaultDevice();
        KPVideoRun *run=[[KPVideoRun alloc] initWithLayer:layer useVT:YES];
        NSDictionary *r=[run rangeForPacket:[packet base64EncodedStringWithOptions:0] samples:points reportedFull:YES];
        if (!r) return 4;
        NSData *out=[NSJSONSerialization dataWithJSONObject:r options:0 error:nil];
        fwrite(out.bytes,1,out.length,stdout); fputc('\n',stdout);
        return [r[@"confident"] boolValue] && [r[@"fullRange"] boolValue]==(atoi(argv[3])!=0) ? 0 : 5;
    }
}
