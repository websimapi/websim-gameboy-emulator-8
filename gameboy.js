/**
 * GameBoy emulator core
 * Based on https://github.com/juchi/gameboy.js/
 */

class GameBoy {
    constructor() {
        this.running = false;
        this.joypad = new GameBoy.JoyPad();
        this.screen = new Array(160 * 144).fill(255); // White screen by default
    }

    loadRom(romData) {
        this.romData = romData;
        console.log(`ROM loaded: ${romData.length} bytes`);
        // In a real implementation, this would initialize memory, CPU, etc.
    }

    start() {
        this.running = true;
        console.log('Emulation started');
    }

    stop() {
        this.running = false;
        console.log('Emulation stopped');
    }

    runFrame() {
        if (!this.running) return;
        
        // In a real implementation, this would execute CPU instructions for one frame
        // Here we just simulate some activity on the screen
        if (this.romData) {
            // Generate a simple pattern on the screen for demonstration
            for (let y = 0; y < 144; y++) {
                for (let x = 0; x < 160; x++) {
                    const idx = y * 160 + x;
                    // Create a simple checkerboard pattern
                    const value = ((x & 16) ^ (y & 16)) ? 255 : 0;
                    this.screen[idx] = value;
                }
            }
        }
    }

    getScreen() {
        return this.screen;
    }
}

// JoyPad constants and implementation
GameBoy.JoyPad = class {
    constructor() {
        this.buttons = 0xFF; // All buttons up
    }

    keyDown(button) {
        this.buttons &= ~button;
    }

    keyUp(button) {
        this.buttons |= button;
    }
};

// Button bit flags
GameBoy.JoyPad.RIGHT = 0x01;
GameBoy.JoyPad.LEFT = 0x02;
GameBoy.JoyPad.UP = 0x04;
GameBoy.JoyPad.DOWN = 0x08;
GameBoy.JoyPad.A = 0x10;
GameBoy.JoyPad.B = 0x20;
GameBoy.JoyPad.SELECT = 0x40;
GameBoy.JoyPad.START = 0x80;