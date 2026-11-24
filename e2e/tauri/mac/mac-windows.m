#import <AppKit/AppKit.h>
#import <ApplicationServices/ApplicationServices.h>
#import <CoreGraphics/CoreGraphics.h>
#import <Foundation/Foundation.h>

static id attribute(AXUIElementRef element, CFStringRef name) {
  CFTypeRef value = NULL;
  if (AXUIElementCopyAttributeValue(element, name, &value) != kAXErrorSuccess) return nil;
  return CFBridgingRelease(value);
}

static NSDictionary *frameOf(AXUIElementRef window) {
  CGPoint origin = CGPointZero;
  CGSize size = CGSizeZero;
  id position = attribute(window, kAXPositionAttribute);
  id extent = attribute(window, kAXSizeAttribute);
  if (position) AXValueGetValue((__bridge AXValueRef)position, kAXValueTypeCGPoint, &origin);
  if (extent) AXValueGetValue((__bridge AXValueRef)extent, kAXValueTypeCGSize, &size);
  return @{@"x" : @(origin.x), @"y" : @(origin.y), @"width" : @(size.width), @"height" : @(size.height)};
}

static BOOL readsAs(id name, NSString *label) {
  if (![name isKindOfClass:[NSString class]]) return NO;
  NSCharacterSet *decoration = [[NSCharacterSet alphanumericCharacterSet] invertedSet];
  return [[name stringByTrimmingCharactersInSet:decoration] isEqualToString:label];
}

static BOOL pressButton(AXUIElementRef element, NSString *label, int depth) {
  if (depth > 60) return NO;
  NSString *role = attribute(element, kAXRoleAttribute);
  BOOL pressable = [role isEqualToString:(__bridge NSString *)kAXButtonRole] ||
                   [role isEqualToString:(__bridge NSString *)kAXRadioButtonRole];
  if (pressable && (readsAs(attribute(element, kAXDescriptionAttribute), label) ||
                    readsAs(attribute(element, kAXTitleAttribute), label))) {
    return AXUIElementPerformAction(element, kAXPressAction) == kAXErrorSuccess;
  }
  for (id child in attribute(element, kAXChildrenAttribute) ?: @[]) {
    if (pressButton((__bridge AXUIElementRef)child, label, depth + 1)) return YES;
  }
  return NO;
}

static int press(pid_t pid, NSString *label) {
  AXUIElementRef app = AXUIElementCreateApplication(pid);
  BOOL pressed = pressButton(app, label, 0);
  CFRelease(app);
  if (!pressed) fprintf(stderr, "no button \"%s\" in the app's windows\n", label.UTF8String);
  return pressed ? 0 : 1;
}

static int fullscreen(pid_t pid) {
  AXUIElementRef app = AXUIElementCreateApplication(pid);
  NSArray *windows = attribute(app, kAXWindowsAttribute) ?: @[];
  AXError result = windows.count == 0
                       ? kAXErrorNoValue
                       : AXUIElementSetAttributeValue((__bridge AXUIElementRef)windows[0], CFSTR("AXFullScreen"),
                                                      kCFBooleanTrue);
  CFRelease(app);
  return result == kAXErrorSuccess ? 0 : 1;
}

static void dump(AXUIElementRef element, int depth, int *left) {
  if (depth > 40 || *left <= 0) return;
  *left -= 1;
  NSString *line = [NSString stringWithFormat:@"%*s%@ %@ title=%@ description=%@", depth * 2, "",
                                              attribute(element, kAXRoleAttribute) ?: @"?",
                                              attribute(element, kAXSubroleAttribute) ?: @"",
                                              attribute(element, kAXTitleAttribute) ?: @"",
                                              attribute(element, kAXDescriptionAttribute) ?: @""];
  printf("%s\n", line.UTF8String);
  for (id child in attribute(element, kAXChildrenAttribute) ?: @[]) dump((__bridge AXUIElementRef)child, depth + 1, left);
}

static int tree(pid_t pid) {
  AXUIElementRef app = AXUIElementCreateApplication(pid);
  int left = 3000;
  dump(app, 0, &left);
  CFRelease(app);
  return 0;
}

static int describe(pid_t pid) {
  @autoreleasepool {
    NSMutableDictionary *facts = [NSMutableDictionary dictionary];
    facts[@"trusted"] = @(AXIsProcessTrusted());
    facts[@"active"] = @([NSRunningApplication runningApplicationWithProcessIdentifier:pid].active);

    NSArray *onScreen = CFBridgingRelease(
        CGWindowListCopyWindowInfo(kCGWindowListOptionOnScreenOnly | kCGWindowListExcludeDesktopElements, kCGNullWindowID));
    NSMutableArray *frontToBack = [NSMutableArray array];
    for (NSDictionary *w in onScreen) {
      if ([w[(__bridge id)kCGWindowLayer] intValue] != 0) continue;
      if (facts[@"frontmostPid"] == nil) facts[@"frontmostPid"] = w[(__bridge id)kCGWindowOwnerPID];
      if ([w[(__bridge id)kCGWindowOwnerPID] intValue] != pid) continue;
      NSDictionary *b = w[(__bridge id)kCGWindowBounds];
      [frontToBack addObject:@{
        @"number" : w[(__bridge id)kCGWindowNumber],
        @"title" : w[(__bridge id)kCGWindowName] ?: @"",
        @"x" : b[@"X"],
        @"y" : b[@"Y"],
        @"width" : b[@"Width"],
        @"height" : b[@"Height"],
      }];
    }
    facts[@"windows"] = frontToBack;

    NSArray *all = CFBridgingRelease(CGWindowListCopyWindowInfo(kCGWindowListOptionAll, kCGNullWindowID));
    NSMutableArray *anywhere = [NSMutableArray array];
    for (NSDictionary *w in all) {
      if ([w[(__bridge id)kCGWindowOwnerPID] intValue] != pid || [w[(__bridge id)kCGWindowLayer] intValue] != 0) continue;
      NSString *title = w[(__bridge id)kCGWindowName];
      if (title.length > 0) [anywhere addObject:title];
    }
    facts[@"anywhere"] = anywhere;
    NSRect screen = NSScreen.mainScreen.frame;
    facts[@"screen"] = @{@"width" : @(screen.size.width), @"height" : @(screen.size.height)};

    AXUIElementRef app = AXUIElementCreateApplication(pid);
    NSMutableArray *ax = [NSMutableArray array];
    for (id window in attribute(app, kAXWindowsAttribute) ?: @[]) {
      AXUIElementRef w = (__bridge AXUIElementRef)window;
      NSMutableDictionary *one = [frameOf(w) mutableCopy];
      one[@"title"] = attribute(w, kAXTitleAttribute) ?: @"";
      one[@"subrole"] = attribute(w, kAXSubroleAttribute) ?: @"";
      one[@"main"] = attribute(w, kAXMainAttribute) ?: @NO;
      [ax addObject:one];
    }
    facts[@"ax"] = ax;
    id focused = attribute(app, kAXFocusedWindowAttribute);
    facts[@"focused"] = focused ? (attribute((__bridge AXUIElementRef)focused, kAXTitleAttribute) ?: @"") : [NSNull null];
    CFRelease(app);

    NSData *json = [NSJSONSerialization dataWithJSONObject:facts options:0 error:nil];
    fwrite(json.bytes, 1, json.length, stdout);
    fputc('\n', stdout);
  }
  return 0;
}

int main(int argc, const char *argv[]) {
  @autoreleasepool {
    if (argc == 3 && strcmp(argv[1], "facts") == 0) return describe((pid_t)atoi(argv[2]));
    if (argc == 4 && strcmp(argv[1], "press") == 0) return press((pid_t)atoi(argv[2]), @(argv[3]));
    if (argc == 3 && strcmp(argv[1], "tree") == 0) return tree((pid_t)atoi(argv[2]));
    if (argc == 3 && strcmp(argv[1], "fullscreen") == 0) return fullscreen((pid_t)atoi(argv[2]));
    fprintf(stderr, "usage: mac-windows facts <pid> | press <pid> <button label> | tree <pid> | fullscreen <pid>\n");
    return 2;
  }
}
