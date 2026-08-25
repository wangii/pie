// PIE Native GUI - macOS platform backend with the official Metal renderer.
//
// Native Cocoa shell: NSApplication + NSWindow whose content view is an MTKView.
// ImGui_ImplOSX is the ImGui platform backend (IME/keyboard/mouse) and
// ImGui_ImplMetal is the renderer. GLFW is not used here: the MTKView supplies
// the drawable/render-pass each frame and the command queue/device come from
// MTLCreateSystemDefaultDevice. Follows Dear ImGui's example_apple_metal main.mm.
//
// The AppLogic callbacks are driven from the MTKView delegate's drawInMTKView.
#include "plats/Platform.h"

#import <Cocoa/Cocoa.h>
#import <Metal/Metal.h>
#import <MetalKit/MetalKit.h>

#include <imgui.h>
#include <imgui_impl_metal.h>
#include <imgui_impl_osx.h>

#include <memory>

namespace pie::gui {

// C++ holder for the platform callbacks + config. Owned by the ObjC object via
// a unique_ptr ivar so its std::function members are managed safely and the
// ivar type is a complete C++ type at the ivar-declaration point.
struct PieMetalState {
    AppLogic logic;
    AppConfig config;
    bool shouldShutdown = false;
    bool appStarted = false;
};

} // namespace pie::gui

// ObjC declarations must be at global scope, not inside a C++ namespace.
// Bring the platform types into this translation unit's global scope so the
// ObjC class bodies can refer to them unqualified.
using pie::gui::AppLogic;
using pie::gui::AppConfig;
using pie::gui::PieMetalState;

// ObjC delegate for a single MTKView. Keeps the C++ callbacks in a
// std::unique_ptr<PieMetalState> ivar and drives the Metal frame loop.
@interface PieMetalApp : NSObject <MTKViewDelegate>
@property (nonatomic, strong) id<MTLDevice> device;
@property (nonatomic, strong) id<MTLCommandQueue> commandQueue;
@property (nonatomic, strong) MTKView* mtkView;
@property (nonatomic, assign) NSWindow* window; // weak
- (instancetype)initWithConfig:(const pie::gui::AppConfig&)config logic:(pie::gui::AppLogic)logic;
- (void)run;
@end

@implementation PieMetalApp {
    std::unique_ptr<PieMetalState> _state;
}
- (instancetype)initWithConfig:(const pie::gui::AppConfig&)config logic:(pie::gui::AppLogic)logic {
    self = [super init];
    if (self) {
        _state.reset(new PieMetalState());
        _state->config = config;
        _state->logic = std::move(logic);
    }
    return self;
}

- (void)run {
    // Common ImGui setup, then native window + MTKView.
    _state->logic.setupImGui();

    _device = MTLCreateSystemDefaultDevice();
    _commandQueue = [_device newCommandQueue];
    if (!_device) { std::fprintf(stderr, "Metal is not supported\n"); std::abort(); }

    NSRect frame = NSMakeRect(0, 0, _state->config.width, _state->config.height);
    NSWindowStyleMask style = NSWindowStyleMaskTitled | NSWindowStyleMaskClosable |
                              NSWindowStyleMaskResizable | NSWindowStyleMaskMiniaturizable;
    NSWindow* win = [[NSWindow alloc] initWithContentRect:frame styleMask:style
                                                  backing:NSBackingStoreBuffered defer:NO];
    win.title = [NSString stringWithUTF8String:_state->config.title.c_str()];
    win.contentMinSize = NSMakeSize(_state->config.minWidth, _state->config.minHeight);
    _window = win;

    MTKView* view = [[MTKView alloc] initWithFrame:frame device:_device];
    view.delegate = self;
    view.device = _device;
    view.colorPixelFormat = MTLPixelFormatBGRA8Unorm;
    win.contentView = view;
    _mtkView = view;

    [win center];
    [win makeKeyAndOrderFront:nil];

    ImGui_ImplMetal_Init(_device);
    ImGui_ImplOSX_Init(view);

    if (!_state->logic.setupApp()) {
        ImGui_ImplOSX_Shutdown(); ImGui_ImplMetal_Shutdown(); ImGui::DestroyContext();
        [win close];
        return;
    }

    [NSApp activateIgnoringOtherApps:YES];
    [win makeKeyAndOrderFront:nil];

    // Blocking Cocoa event loop; MTKViewDelegate drives frames.
    // Ctrl+Command+F toggles native fullscreen (the macOS convention), matching
    // the green-button / View menu behavior. Intercept it so ImGui_ImplOSX
    // never sees the F keypress (F is otherwise unused by the UI).
    while (!_state->shouldShutdown) {
        NSEvent* event = [NSApp nextEventMatchingMask:NSEventMaskAny
                                            untilDate:[NSDate dateWithTimeIntervalSinceNow:0.01]
                                               inMode:NSDefaultRunLoopMode
                                              dequeue:YES];
        if (event) {
            if (event.type == NSEventTypeKeyDown) {
                NSEventModifierFlags mods = event.modifierFlags;
                // kVK_ANSI_F == 0x03; Ctrl+Cmd (Control | Command) is checked.
                if ((mods & NSEventModifierFlagControl) && (mods & NSEventModifierFlagCommand) &&
                    event.keyCode == 0x03) {
                    [win toggleFullScreen:nil];
                } else if ((mods & NSEventModifierFlagCommand) &&
                           !(mods & (NSEventModifierFlagControl | NSEventModifierFlagOption | NSEventModifierFlagShift)) &&
                           event.keyCode == 0x0C) { // kVK_ANSI_Q == 0x0C; Cmd+Q quits
                    _state->shouldShutdown = true;
                } else {
                    [NSApp sendEvent:event];
                }
            } else {
                [NSApp sendEvent:event];
            }
        }
        [view draw];
    }

    _state->logic.onExit();
    ImGui_ImplOSX_Shutdown();
    ImGui_ImplMetal_Shutdown();
    ImGui::DestroyContext();
    [win close];
    _state.reset();
}

- (void)drawInMTKView:(MTKView*)view {
    ImGuiIO& io = ImGui::GetIO();
    io.DisplaySize.x = view.bounds.size.width;
    io.DisplaySize.y = view.bounds.size.height;
    CGFloat scale = view.window.screen.backingScaleFactor ?: NSScreen.mainScreen.backingScaleFactor ?: 1.0;
    io.DisplayFramebufferScale = ImVec2(scale, scale);

    id<MTLCommandBuffer> commandBuffer = [_commandQueue commandBuffer];
    MTLRenderPassDescriptor* rp = view.currentRenderPassDescriptor;
    if (rp == nil) { [commandBuffer commit]; return; }

    ImGui_ImplMetal_NewFrame(rp);
    ImGui_ImplOSX_NewFrame(view);
    ImGui::NewFrame();

    if (_state->appStarted) {
        _state->logic.onFrameStart();
        _state->logic.onDraw();
    }
    _state->appStarted = true;

    ImGui::Render();
    ImDrawData* drawData = ImGui::GetDrawData();
    if (drawData) {
        rp.colorAttachments[0].clearColor = MTLClearColorMake(0.055, 0.065, 0.08, 1.0);
        id<MTLRenderCommandEncoder> enc = [commandBuffer renderCommandEncoderWithDescriptor:rp];
        ImGui_ImplMetal_RenderDrawData(drawData, commandBuffer, enc);
        [enc endEncoding];
        [commandBuffer presentDrawable:view.currentDrawable];
    }
    [commandBuffer commit];
}

- (void)mtkView:(MTKView*)view drawableSizeWillChange:(CGSize)size { (void)view; (void)size; }
- (void)windowWillClose:(NSNotification*)note { (void)note; _state->shouldShutdown = true; }
@end

namespace pie::gui {

int runPlatform(const AppConfig& cfg, AppLogic logic) {
    @autoreleasepool {
        [NSApplication sharedApplication];
        [NSApp setActivationPolicy:NSApplicationActivationPolicyRegular];
        PieMetalApp* app = [[PieMetalApp alloc] initWithConfig:cfg logic:std::move(logic)];
        [app run];
    }
    return 0;
}

} // namespace pie::gui


