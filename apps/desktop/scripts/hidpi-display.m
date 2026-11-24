#import <CoreGraphics/CoreGraphics.h>
#import <Foundation/Foundation.h>

// CGVirtualDisplay is CoreGraphics' private API for virtual displays (macOS 11+); it ships no header.
@interface CGVirtualDisplayDescriptor : NSObject
@property(retain, nonatomic) dispatch_queue_t queue;
@property(retain, nonatomic) NSString *name;
@property(nonatomic) unsigned int maxPixelsHigh;
@property(nonatomic) unsigned int maxPixelsWide;
@property(nonatomic) CGSize sizeInMillimeters;
@property(nonatomic) unsigned int serialNum;
@property(nonatomic) unsigned int productID;
@property(nonatomic) unsigned int vendorID;
@end

@interface CGVirtualDisplayMode : NSObject
- (instancetype)initWithWidth:(unsigned int)width height:(unsigned int)height refreshRate:(double)refreshRate;
@end

@interface CGVirtualDisplaySettings : NSObject
@property(retain, nonatomic) NSArray *modes;
@property(nonatomic) unsigned int hiDPI;
@end

@interface CGVirtualDisplay : NSObject
- (instancetype)initWithDescriptor:(CGVirtualDisplayDescriptor *)descriptor;
- (BOOL)applySettings:(CGVirtualDisplaySettings *)settings;
@property(readonly, nonatomic) unsigned int displayID;
@end

static void describe(CGDirectDisplayID display) {
  CGDisplayModeRef mode = CGDisplayCopyDisplayMode(display);
  printf("display %u: %zux%zu points, %zux%zu pixels\n", display, CGDisplayModeGetWidth(mode),
         CGDisplayModeGetHeight(mode), CGDisplayModeGetPixelWidth(mode), CGDisplayModeGetPixelHeight(mode));
  CGDisplayModeRelease(mode);
}

int main(void) {
  @autoreleasepool {
    CGVirtualDisplayDescriptor *descriptor = [CGVirtualDisplayDescriptor new];
    descriptor.queue = dispatch_get_main_queue();
    descriptor.name = @"Retina";
    descriptor.maxPixelsWide = 2880;
    descriptor.maxPixelsHigh = 1800;
    descriptor.sizeInMillimeters = CGSizeMake(302, 189);
    descriptor.serialNum = 1;
    descriptor.productID = 0x7e55;
    descriptor.vendorID = 0x7e55;
    CGVirtualDisplay *virtualDisplay = [[CGVirtualDisplay alloc] initWithDescriptor:descriptor];
    CGVirtualDisplaySettings *settings = [CGVirtualDisplaySettings new];
    settings.hiDPI = 1;
    settings.modes = @[ [[CGVirtualDisplayMode alloc] initWithWidth:1440 height:900 refreshRate:60] ];
    if (virtualDisplay == nil || ![virtualDisplay applySettings:settings]) {
      fprintf(stderr, "could not create a HiDPI virtual display\n");
      return 1;
    }
    CGDirectDisplayID display = virtualDisplay.displayID;
    NSDictionary *all = @{(__bridge NSString *)kCGDisplayShowDuplicateLowResolutionModes : @YES};
    NSArray *modes = CFBridgingRelease(CGDisplayCopyAllDisplayModes(display, (__bridge CFDictionaryRef)all));
    CGDisplayModeRef hidpi = NULL;
    for (id each in modes) {
      CGDisplayModeRef mode = (__bridge CGDisplayModeRef)each;
      if (CGDisplayModeGetPixelWidth(mode) == 2 * CGDisplayModeGetWidth(mode)) hidpi = mode;
    }
    if (hidpi != NULL) {
      CGDisplayConfigRef config;
      CGBeginDisplayConfiguration(&config);
      CGConfigureDisplayWithDisplayMode(config, display, hidpi, NULL);
      CGCompleteDisplayConfiguration(config, kCGConfigureForSession);
    }
    describe(display);
    CGRect bounds = CGDisplayBounds(display);
    printf("bounds %.0f %.0f %.0f %.0f\n", bounds.origin.x, bounds.origin.y, bounds.size.width, bounds.size.height);
    fflush(stdout);
    dispatch_main();
  }
}
