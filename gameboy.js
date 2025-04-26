/**
 * GameBoy emulator core
 * Based on https://github.com/juchi/gameboy.js/
 */

// Define JoyPad constants
const JoyPad = {
    UP: 0x04,
    DOWN: 0x08,
    LEFT: 0x02,
    RIGHT: 0x01,
    A: 0x10,
    B: 0x20,
    SELECT: 0x40,
    START: 0x80
};

// Main GameBoy class - wrapper for the GameboyJS implementation
class GameBoy {
    constructor() {
        this.canvas = document.getElementById('screen');
        
        // Set up internal emulator components
        this.gameboy = new GameboyJS.Gameboy(this.canvas);
        
        // Set up joypad interface
        this.joypad = {
            keyDown: (key) => {
                this.gameboy.input.pressKey(this.mapKeyCode(key));
            },
            keyUp: (key) => {
                this.gameboy.input.releaseKey(this.mapKeyCode(key));
            }
        };
        
        this.isRunning = false;
        this.screenData = new Uint8Array(160 * 144);
    }
    
    // Map between external and internal key codes
    mapKeyCode(key) {
        const keyMap = {
            [JoyPad.UP]: 'UP',
            [JoyPad.DOWN]: 'DOWN',
            [JoyPad.LEFT]: 'LEFT',
            [JoyPad.RIGHT]: 'RIGHT',
            [JoyPad.A]: 'A',
            [JoyPad.B]: 'B',
            [JoyPad.SELECT]: 'SELECT',
            [JoyPad.START]: 'START'
        };
        return keyMap[key];
    }
    
    // Load a ROM into the emulator
    loadRom(romData) {
        this.rom = {
            data: romData
        };
        this.gameboy.startRom(this.rom);
    }
    
    // Start emulation
    start() {
        this.isRunning = true;
    }
    
    // Stop emulation
    stop() {
        this.isRunning = false;
        this.gameboy.cpu.stop();
    }
    
    // Run a single frame
    runFrame() {
        if (!this.isRunning) return;
        
        // Get screen buffer from GPU
        const buffer = this.gameboy.cpu.gpu.buffer;
        
        // Convert the buffer to grayscale values for our interface
        for (let i = 0; i < buffer.length; i++) {
            // Map buffer colors (0-3) to grayscale values (0-255)
            this.screenData[i] = buffer[i] * 85;
        }
    }
    
    // Get screen data
    getScreen() {
        return this.screenData;
    }
}

// Add JoyPad constants to the GameBoy class
GameBoy.JoyPad = JoyPad;

// Import the original GameboyJS code
var GameboyJS;
(function (GameboyJS) {
    "use strict";

    // CPU class
    var CPU = function(gameboy) {
        this.gameboy = gameboy;

        this.r = {A:0, F: 0, B:0, C:0, D:0, E:0, H:0, L:0, pc:0, sp:0};
        this.IME = true;
        this.clock = {c: 0, serial: 0};
        this.isHalted = false;
        this.isPaused = false;
        this.usingBootRom = false;

        this.createDevices();
    };

    CPU.INTERRUPTS = {
        VBLANK: 0,
        LCDC:   1,
        TIMER:  2,
        SERIAL: 3,
        HILO:   4
    };
    CPU.interruptRoutines = {
        0: function(p){GameboyJS.cpuOps.RSTn(p, 0x40);},
        1: function(p){GameboyJS.cpuOps.RSTn(p, 0x48);},
        2: function(p){GameboyJS.cpuOps.RSTn(p, 0x50);},
        3: function(p){GameboyJS.cpuOps.RSTn(p, 0x58);},
        4: function(p){GameboyJS.cpuOps.RSTn(p, 0x60);}
    };

    CPU.prototype.createDevices = function() {
        this.memory = new GameboyJS.Memory(this);
        this.timer = new GameboyJS.Timer(this, this.memory);
        this.apu = new GameboyJS.APU(this.memory);

        this.SERIAL_INTERNAL_INSTR = 512; // instr to wait per bit if internal clock
        this.enableSerial = 0;
        this.serialHandler = GameboyJS.ConsoleSerial;
    };

    CPU.prototype.reset = function() {
        this.memory.reset();

        this.r.sp = 0xFFFE;
    };

    CPU.prototype.loadRom = function(data) {
        this.memory.setRomData(data);
    };

    CPU.prototype.getRamSize = function() {
        var size = 0;
        switch (this.memory.rb(0x149)) {
            case 1:
                size = 2048;
                break;
            case 2:
                size = 2048 * 4;
                break;
            case 3:
                size = 2048 * 16;
                break;
        }

        return size;
    };

    CPU.prototype.getGameName = function() {
        var name = '';
        for (var i = 0x134; i < 0x143; i++) {
            var char = this.memory.rb(i) || 32;
            name += String.fromCharCode(char);
        }

        return name;
    };

    // Start the execution of the emulator
    CPU.prototype.run = function() {
        if (this.usingBootRom) {
            this.r.pc = 0x0000;
        } else {
            this.r.pc = 0x0100;
        }
        this.frame();
    };

    CPU.prototype.stop = function() {
        clearTimeout(this.nextFrameTimer);
    };

    // Fetch-and-execute loop
    // Will execute instructions for the duration of a frame
    //
    // The screen unit will notify the vblank period which
    // is considered the end of a frame
    //
    // The function is called on a regular basis with a timeout
    CPU.prototype.frame = function() {
        if (!this.isPaused) {
            this.nextFrameTimer = setTimeout(this.frame.bind(this), 1000 / GameboyJS.Screen.physics.FREQUENCY);
        }

        try {
            var vblank = false;
            while (!vblank) {
                var oldInstrCount = this.clock.c;
                if (!this.isHalted) {
                    var opcode = this.fetchOpcode();
                    GameboyJS.opcodeMap[opcode](this);
                    this.r.F &= 0xF0; // tmp fix

                    if (this.enableSerial) {
                        var instr = this.clock.c - oldInstrCount;
                        this.clock.serial += instr;
                        if (this.clock.serial >= 8 * this.SERIAL_INTERNAL_INSTR) {
                            this.endSerialTransfer();
                        }
                    }
                } else {
                    this.clock.c += 4;
                }

                var elapsed = this.clock.c - oldInstrCount;
                vblank = this.gpu.update(elapsed);
                this.timer.update(elapsed);
                this.input.update();
                this.apu.update(elapsed);
                this.checkInterrupt();
            }
            this.clock.c = 0;
        } catch (e) {
            this.gameboy.handleException(e);
        }
    };

    CPU.prototype.fetchOpcode = function() {
        var opcode = this.memory.rb(this.r.pc++);
        if (opcode === undefined) {console.log(opcode + ' at ' + (this.r.pc-1).toString(16));this.stop();return;}
        if (!GameboyJS.opcodeMap[opcode]) {
            console.error('Unknown opcode '+opcode.toString(16)+' at address '+(this.r.pc-1).toString(16)+', stopping execution...');
            this.stop();
            return null;
        }

        return opcode;
    };

    CPU.prototype.rr = function(register) {
        return this.r[register];
    };

    CPU.prototype.wr = function(register, value) {
        this.r[register] = value;
    };

    CPU.prototype.halt = function() {
        this.isHalted = true;
    }
    CPU.prototype.unhalt = function() {
        this.isHalted = false;
    }
    CPU.prototype.pause = function() {
        this.isPaused = true;
    }
    CPU.prototype.unpause = function() {
        if (this.isPaused) {
            this.isPaused = false;
            this.frame();
        }
    }

    CPU.prototype.checkInterrupt = function() {
        if (!this.IME) {
            return;
        }
        for (var i = 0; i < 5; i++) {
            var IFval = this.memory.rb(0xFF0F);
            if (GameboyJS.Util.readBit(IFval, i) && this.isInterruptEnable(i)) {
                IFval &= (0xFF - (1<<i));
                this.memory.wb(0xFF0F, IFval);
                this.disableInterrupts();
                this.clock.c += 4; 
                GameboyJS.CPU.interruptRoutines[i](this);
                break;
            }
        }
    }

    CPU.prototype.requestInterrupt = function(type) {
        var IFval = this.memory.rb(0xFF0F);
        IFval |= (1 << type)
        this.memory.wb(0xFF0F, IFval) ;
        this.unhalt();
    }

    CPU.prototype.isInterruptEnable = function(type) {
        return GameboyJS.Util.readBit(this.memory.rb(0xFFFF), type) != 0;
    }

    CPU.prototype.enableInterrupts = function() {
        this.IME = true;
    }
    CPU.prototype.disableInterrupts = function() {
        this.IME = false;
    }

    CPU.prototype.enableSerialTransfer = function() {
        this.enableSerial = 1;
        this.clock.serial = 0;
    }

    CPU.prototype.endSerialTransfer = function() {
        this.enableSerial = 0;
        var data = this.memory.rb(0xFF01);
        this.memory.wb(0xFF02, 0);
        this.serialHandler.out(data);
        this.memory.wb(0xFF01, this.serialHandler.in());
    }

    CPU.prototype.resetDivTimer = function() {
        this.timer.resetDiv();
    }

    GameboyJS.CPU = CPU;

    // GPU class
    var GPU = function(screen, cpu) {
        this.cpu = cpu;
        this.screen = screen;

        this.LCDC= 0xFF40;
        this.STAT= 0xFF41;
        this.SCY = 0xFF42;
        this.SCX = 0xFF43;
        this.LY  = 0xFF44;
        this.LYC = 0xFF45;
        this.BGP = 0xFF47;
        this.OBP0= 0xFF48;
        this.OBP1= 0xFF49;
        this.WY  = 0xFF4A;
        this.WX  = 0xFF4B;

        this.vram = cpu.memory.vram.bind(cpu.memory);

        this.OAM_START = 0xFE00;
        this.OAM_END   = 0xFE9F;
        this.deviceram = cpu.memory.deviceram.bind(cpu.memory);
        this.oamram = cpu.memory.oamram.bind(cpu.memory);
        this.VBLANK_TIME = 70224;
        this.clock = 0;
        this.mode = 2;
        this.line = 0;

        this.buffer = new Array(GameboyJS.Screen.physics.WIDTH * GameboyJS.Screen.physics.HEIGHT);
        this.tileBuffer = new Array(8);
        this.bgTileCache = {};
    }

    GPU.prototype.update = function(clockElapsed) {
        this.clock += clockElapsed;
        var vblank = false;

        switch (this.mode) {
            case 0: 
                if (this.clock >= 204) {
                    this.clock -= 204;
                    this.line++;
                    this.updateLY();
                    if (this.line == 144) {
                        this.setMode(1);
                        vblank = true;
                        this.cpu.requestInterrupt(GameboyJS.CPU.INTERRUPTS.VBLANK);
                        this.drawFrame();
                    } else {
                        this.setMode(2);
                    }
                }
                break;
            case 1: 
                if (this.clock >= 456) {
                    this.clock -= 456;
                    this.line++;
                    if (this.line > 153) {
                        this.line = 0;
                        this.setMode(2);
                    }
                    this.updateLY();
                }

                break;
            case 2: 
                if (this.clock >= 80) {
                    this.clock -= 80;
                    this.setMode(3);
                }
                break;
            case 3: 
                if (this.clock >= 172) {
                    this.clock -= 172;
                    this.drawScanLine(this.line);
                    this.setMode(0);
                }
                break;
        }

        return vblank;
    }

    GPU.prototype.updateLY = function() {
        this.deviceram(this.LY, this.line);
        var STAT = this.deviceram(this.STAT);
        if (this.deviceram(this.LY) == this.deviceram(this.LYC)) {
            this.deviceram(this.STAT, STAT | (1 << 2));
            if (STAT & (1 << 6)) {
                this.cpu.requestInterrupt(GameboyJS.CPU.INTERRUPTS.LCDC);
            }
        } else {
            this.deviceram(this.STAT, STAT & (0xFF - (1 << 2)));
        }
    }

    GPU.prototype.setMode = function(mode) {
        this.mode = mode;
        var newSTAT = this.deviceram(this.STAT);
        newSTAT &= 0xFC;
        newSTAT |= mode;
        this.deviceram(this.STAT, newSTAT);

        if (mode < 3) {
            if (newSTAT & (1 << (3+mode))) {
                this.cpu.requestInterrupt(GameboyJS.CPU.INTERRUPTS.LCDC);
            }
        }
    }

    GPU.prototype.drawScanLine = function(line) {
        var LCDC = this.deviceram(this.LCDC);
        var enable = GameboyJS.Util.readBit(LCDC, 7);
        if (enable) {
            var lineBuffer = new Array(GameboyJS.Screen.physics.WIDTH);
            this.drawBackground(LCDC, line, lineBuffer);
            this.drawSprites(LCDC, line, lineBuffer);
        }
    }

    GPU.prototype.drawFrame = function() {
        var LCDC = this.deviceram(this.LCDC);
        var enable = GameboyJS.Util.readBit(LCDC, 7);
        if (enable) {
            this.drawWindow(LCDC);
        }
        this.bgTileCache = {};
        this.screen.render(this.buffer);
    }

    GPU.prototype.drawBackground = function(LCDC, line, lineBuffer) {
        if (!GameboyJS.Util.readBit(LCDC, 0)) {
            return;
        }

        var mapStart = GameboyJS.Util.readBit(LCDC, 3) ? GPU.tilemap.START_1 : GPU.tilemap.START_0;

        var dataStart, signedIndex = false;
        if (GameboyJS.Util.readBit(LCDC, 4)) {
            dataStart = 0x8000;
        } else {
            dataStart = 0x8800;
            signedIndex = true;
        }

        var bgx = this.deviceram(this.SCX);
        var bgy = this.deviceram(this.SCY);
        var tileLine = ((line + bgy) & 7);

        var tileRow = ((((bgy + line) / 8) | 0) & 0x1F);
        var firstTile = ((bgx / 8) | 0) + 32 * tileRow;
        var lastTile = firstTile + GameboyJS.Screen.physics.WIDTH / 8 + 1;
        if ((lastTile & 0x1F) < (firstTile & 0x1F)) {
            lastTile -= 32;
        }
        var x = (firstTile & 0x1F) * 8 - bgx; 
        for (var i = firstTile; i != lastTile; i++, (i & 0x1F) == 0 ? i-=32 : null) {
            var tileIndex = this.vram(i + mapStart);

            if (signedIndex) {
                tileIndex = GameboyJS.Util.getSignedValue(tileIndex) + 128;
            }

            var tileData = this.bgTileCache[tileIndex] || (this.bgTileCache[tileIndex] = this.readTileData(tileIndex, dataStart));

            this.drawTileLine(tileData, tileLine);
            this.copyBGTileLine(lineBuffer, this.tileBuffer, x);
            x += 8;
        }

        this.copyLineToBuffer(lineBuffer, line);
    }

    GPU.prototype.copyBGTileLine = function(lineBuffer, tileBuffer, x) {
        for (var k = 0; k < 8; k++, x++) {
            if (x < 0 || x >= GameboyJS.Screen.physics.WIDTH) continue;
            lineBuffer[x] = tileBuffer[k];
        }
    }

    GPU.prototype.copyLineToBuffer = function(lineBuffer, line) {
        var bgPalette = GPU.getPalette(this.deviceram(this.BGP));

        for (var x = 0; x < GameboyJS.Screen.physics.WIDTH; x++) {
            var color = lineBuffer[x];
            this.drawPixel(x, line, bgPalette[color]);
        }
    }

    GPU.prototype.drawTileLine = function(tileData, line, xflip, yflip) {
        xflip = xflip | 0;
        yflip = yflip | 0;
        var l = yflip ? 7 - line : line;
        var byteIndex = l * 2;
        var b1 = tileData[byteIndex++];
        var b2 = tileData[byteIndex++];

        var offset = 8;
        for (var pixel = 0; pixel < 8; pixel++) {
            offset--;
            var mask = (1 << offset);
            var colorValue = ((b1 & mask) >> offset) + ((b2 & mask) >> offset)*2;
            var p = xflip ? offset : pixel;
            this.tileBuffer[p] = colorValue;
        }
    }

    GPU.prototype.drawSprites = function(LCDC, line, lineBuffer) {
        if (!GameboyJS.Util.readBit(LCDC, 1)) {
            return;
        }
        var spriteHeight = GameboyJS.Util.readBit(LCDC, 2) ? 16 : 8;

        var sprites = new Array();
        for (var i = this.OAM_START; i < this.OAM_END && sprites.length < 10; i += 4) {
            var y = this.oamram(i);
            var x = this.oamram(i+1);
            var index = this.oamram(i+2);
            var flags = this.oamram(i+3);

            if (y - 16 > line || y - 16 < line - spriteHeight) {
                continue;
            }
            sprites.push({x:x, y:y, index:index, flags:flags})
        }

        if (sprites.length == 0) return;

        var cacheTile = {};
        var spriteLineBuffer = new Array(GameboyJS.Screen.physics.WIDTH);

        for (var i = 0; i < sprites.length; i++) {
            var sprite = sprites[i];
            var tileLine = line - sprite.y + 16;
            var paletteNumber = GameboyJS.Util.readBit(flags, 4);
            var xflip = GameboyJS.Util.readBit(sprite.flags, 5);
            var yflip = GameboyJS.Util.readBit(sprite.flags, 6);
            var tileData = cacheTile[sprite.index] || (cacheTile[sprite.index] = this.readTileData(sprite.index, 0x8000, spriteHeight * 2));
            this.drawTileLine(tileData, tileLine, xflip, yflip);
            this.copySpriteTileLine(spriteLineBuffer, this.tileBuffer, sprite.x - 8, paletteNumber);
        }

        this.copySpriteLineToBuffer(spriteLineBuffer, line);
    }

    GPU.prototype.copySpriteTileLine = function(lineBuffer, tileBuffer, x, palette) {
        for (var k = 0; k < 8; k++, x++) {
            if (x < 0 || x >= GameboyJS.Screen.physics.WIDTH || tileBuffer[k] == 0) continue;
            lineBuffer[x] = {color:tileBuffer[k], palette: palette};
        }
    }

    GPU.prototype.copySpriteLineToBuffer = function(spriteLineBuffer, line) {
        var spritePalettes = {};
        spritePalettes[0] = GPU.getPalette(this.deviceram(this.OBP0));
        spritePalettes[1] = GPU.getPalette(this.deviceram(this.OBP1));

        for (var x = 0; x < GameboyJS.Screen.physics.WIDTH; x++) {
            if (!spriteLineBuffer[x]) continue;
            var color = spriteLineBuffer[x].color;
            if (color === 0) continue;
            var paletteNumber = spriteLineBuffer[x].palette;
            this.drawPixel(x, line, spritePalettes[paletteNumber][color]);
        }
    }

    GPU.prototype.drawTile = function(tileData, x, y, buffer, bufferWidth, xflip, yflip, spriteMode) {
        xflip = xflip | 0;
        yflip = yflip | 0;
        spriteMode = spriteMode | 0;
        var byteIndex = 0;
        for (var line = 0; line < 8; line++) {
            var l = yflip ? 7 - line : line;
            var b1 = tileData[byteIndex++];
            var b2 = tileData[byteIndex++];

            for (var pixel = 0; pixel < 8; pixel++) {
                var mask = (1 << (7-pixel));
                var colorValue = ((b1 & mask) >> (7-pixel)) + ((b2 & mask) >> (7-pixel))*2;
                if (spriteMode && colorValue == 0) continue;
                var p = xflip ? 7 - pixel : pixel;
                var bufferIndex = (x + p) + (y + l) * bufferWidth;
                buffer[bufferIndex] = colorValue;
            }
        }
    }

    GPU.prototype.readTileData = function(tileIndex, dataStart, tileSize) {
        tileSize = tileSize || 0x10; 
        var tileData = new Array();

        var tileAddressStart = dataStart + (tileIndex * 0x10);
        for (var i = tileAddressStart; i < tileAddressStart + tileSize; i++) {
            tileData.push(this.vram(i));
        }

        return tileData;
    }

    GPU.prototype.drawWindow = function(LCDC) {
        if (!GameboyJS.Util.readBit(LCDC, 5)) {
            return;
        }

        var buffer = new Array(256*256);
        var mapStart = GameboyJS.Util.readBit(LCDC, 6) ? GPU.tilemap.START_1 : GPU.tilemap.START_0;

        var dataStart, signedIndex = false;
        if (GameboyJS.Util.readBit(LCDC, 4)) {
            dataStart = 0x8000;
        } else {
            dataStart = 0x8800;
            signedIndex = true;
        }

        for (var i = 0; i < GPU.tilemap.LENGTH; i++) {
            var tileIndex = this.vram(i + mapStart);

            if (signedIndex) {
                tileIndex = GameboyJS.Util.getSignedValue(tileIndex) + 128;
            }

            var tileData = this.readTileData(tileIndex, dataStart);
            var x = i % GPU.tilemap.WIDTH;
            var y = (i / GPU.tilemap.WIDTH) | 0;
            this.drawTile(tileData, x * 8, y * 8, buffer, 256);
        }

        var wx = this.deviceram(this.WX) - 7;
        var wy = this.deviceram(this.WY);
        for (var x = Math.max(0, -wx); x < Math.min(GameboyJS.Screen.physics.WIDTH, GameboyJS.Screen.physics.WIDTH - wx); x++) {
            for (var y = Math.max(0, -wy); y < Math.min(GameboyJS.Screen.physics.HEIGHT, GameboyJS.Screen.physics.HEIGHT - wy); y++) {
                var color = buffer[(x & 255) + (y & 255) * 256];
                this.drawPixel(x + wx, y + wy, color);
            }
        }
    }

    GPU.prototype.drawPixel = function(x, y, color) {
        this.buffer[y * 160 + x] = color;
    }

    GPU.prototype.getPixel = function(x, y) {
        return this.buffer[y * 160 + x];
    }

    GPU.tilemap = {
        START_0: 0x9800,
        START_1: 0x9C00,
        WIDTH: 32,
        LENGTH: 1024
    };

    GPU.getPalette = function(paletteByte) {
        var palette = [];
        for (var i = 0; i < 8; i += 2) {
            var shade = (paletteByte & (3 << i)) >> i;
            palette.push(shade);
        }
        return palette;
    }

    GameboyJS.GPU = GPU;

    // Screen class
    var Screen = function(canvas, pixelSize) {
        this.context = canvas.getContext('2d');
        this.canvas = canvas;
        this.pixelSize = pixelSize || 1;
        this.initImageData();
    }

    Screen.prototype.setPixelSize = function(pixelSize) {
        this.pixelSize = pixelSize;
        this.initImageData();
    }

    Screen.prototype.initImageData = function() {
        this.canvas.width = GameboyJS.Screen.physics.WIDTH * this.pixelSize;
        this.canvas.height = GameboyJS.Screen.physics.HEIGHT * this.pixelSize;
        this.imageData = this.context.createImageData(this.canvas.width, this.canvas.height);
    }

    Screen.prototype.clearScreen = function() {
        this.context.fillStyle = '#FFF';
        this.context.fillRect(0, 0, GameboyJS.Screen.physics.WIDTH * this.pixelSize, GameboyJS.Screen.physics.HEIGHT * this.pixelSize);
    }

    Screen.prototype.fillImageData = function(buffer) {
        for (var y = 0; y < GameboyJS.Screen.physics.HEIGHT; y++) {
            for (var py = 0; py < this.pixelSize; py++) {
                var _y = y * this.pixelSize + py;
                for (var x = 0; x < GameboyJS.Screen.physics.WIDTH; x++) {
                    for (var px = 0; px < this.pixelSize; px++) {
                        var offset = _y * this.canvas.width + (x * this.pixelSize + px);
                        var v = GameboyJS.Screen.colors[buffer[y * GameboyJS.Screen.physics.WIDTH + x]];
                        this.imageData.data[offset * 4] = v;
                        this.imageData.data[offset * 4 + 1] = v;
                        this.imageData.data[offset * 4 + 2] = v;
                        this.imageData.data[offset * 4 + 3] = 255;
                    }
                }
            }
        }
    }

    Screen.prototype.render = function(buffer) {
        this.fillImageData(buffer);
        this.context.putImageData(this.imageData, 0, 0);
    }

    GameboyJS.Screen = Screen;
    GameboyJS.Screen.physics = {
        WIDTH: 160,
        HEIGHT: 144,
        FREQUENCY: 59.73
    };
    GameboyJS.Screen.colors = [
        255, 255, 255, // white
        192, 192, 192, // light gray
        96, 96, 96, // dark gray
        0, 0, 0 // black
    ];

    // APU class
    var APU = function(memory) {
        this.memory = memory;
        this.enabled = false;

        AudioContext = window.AudioContext || window.webkitAudioContext;
        var audioContext = new AudioContext();

        this.channel1 = new GameboyJS.Channel1(this, 1, audioContext);
        this.channel2 = new GameboyJS.Channel1(this, 2, audioContext);
        this.channel3 = new GameboyJS.Channel3(this, 3, audioContext);
        this.channel4 = new GameboyJS.Channel4(this, 4, audioContext);

    }

    APU.prototype.connect = function() {
        this.channel1.enable();
        this.channel2.enable();
        this.channel3.enable();
    }
    APU.prototype.disconnect = function() {
        this.channel1.disable();
        this.channel2.disable();
        this.channel3.disable();
    }
    APU.prototype.update = function(clockElapsed) {
        if (this.enabled == false) return;

        this.channel1.update(clockElapsed);
        this.channel2.update(clockElapsed);
        this.channel3.update(clockElapsed);
        this.channel4.update(clockElapsed);
    }
    APU.prototype.setSoundFlag = function(channel, value) {
        var mask = 0xFF - (1 << (channel - 1));
        value = value << (channel - 1)
        var byteValue = this.memory.rb(APU.registers.NR52);
        byteValue &= mask;
        byteValue |= value;
        this.memory[APU.registers.NR52] = byteValue;
    }
    APU.prototype.manageWrite = function(addr, value) {
        if (this.enabled == false && addr < APU.registers.NR52) {
            return;
        }
        this.memory[addr] = value;

        switch (addr) {
            case 0xFF10:
                this.channel1.clockSweep = 0;
                this.channel1.sweepTime = ((value & 0x70) >> 4);
                this.channel1.sweepSign = (value & 0x08) ? -1 : 1;
                this.channel1.sweepShifts = (value & 0x07);
                this.channel1.sweepCount = this.channel1.sweepShifts;
                break;
            case 0xFF11:
                this.channel1.setLength(value & 0x3F);
                break;
            case 0xFF12:
                this.channel1.envelopeSign = (value & 0x08) ? 1 : -1;
                var envelopeVolume = (value & 0xF0) >> 4;
                this.channel1.setEnvelopeVolume(envelopeVolume);
                this.channel1.envelopeStep = (value & 0x07);
                break;
            case 0xFF13:
                var frequency = this.channel1.getFrequency();
                frequency &= 0xF00;
                frequency |= value;
                this.channel1.setFrequency(frequency);
                break;
            case 0xFF14:
                var frequency = this.channel1.getFrequency();
                frequency &= 0xFF;
                frequency |= (value & 7) << 8;
                this.channel1.setFrequency(frequency);
                this.channel1.lengthCheck = (value & 0x40) ? true : false;
                if (value & 0x80) this.channel1.play();
                break;

            case 0xFF16:
                this.channel2.setLength(value & 0x3F);
                break;
            case 0xFF17:
                this.channel2.envelopeSign = (value & 0x08) ? 1 : -1;
                var envelopeVolume = (value & 0xF0) >> 4;
                this.channel2.setEnvelopeVolume(envelopeVolume);
                this.channel2.envelopeStep = (value & 0x07);
                break;
            case 0xFF18:
                var frequency = this.channel2.getFrequency();
                frequency &= 0xF00;
                frequency |= value;
                this.channel2.setFrequency(frequency);
                break;
            case 0xFF19:
                var frequency = this.channel2.getFrequency();
                frequency &= 0xFF;
                frequency |= (value & 7) << 8;
                this.channel2.setFrequency(frequency);
                this.channel2.lengthCheck = (value & 0x40) ? true : false;
                if (value & 0x80) {
                    this.channel2.play();
                }
                break;

            case 0xFF1A:
                break;
            case 0xFF1B:
                this.channel3.setLength(value);
                break;
            case 0xFF1C:
                break;
            case 0xFF1D:
                var frequency = this.channel3.getFrequency();
                frequency &= 0xF00;
                frequency |= value;
                this.channel3.setFrequency(frequency);
                break;
            case 0xFF1E:
                var frequency = this.channel3.getFrequency();
                frequency &= 0xFF;
                frequency |= (value & 7) << 8;
                this.channel3.setFrequency(frequency);
                this.channel3.lengthCheck = (value & 0x40) ? true : false;
                if (value & 0x80) {
                    this.channel3.play();
                }
                break;

            case 0xFF20:
                this.channel4.setLength(value & 0x3F);
                break;
            case 0xFF21:
                break;
            case 0xFF22:
                break;
            case 0xFF23:
                this.channel4.lengthCheck = (value & 0x40) ? true : false;
                if (value & 0x80) {
                    this.channel4.play();
                }
                break;

            case 0xFF30:case 0xFF31:case 0xFF32:case 0xFF33:case 0xFF34:case 0xFF35:case 0xFF36:case 0xFF37:
            case 0xFF38:case 0xFF39:case 0xFF3A:case 0xFF3B:case 0xFF3C:case 0xFF3D:case 0xFF3E:case 0xFF3F:
                var index = addr - 0xFF30;
                this.channel3.setWaveBufferByte(index, value);
                break;

            case 0xFF26:
                value &= 0xF0;
                this.memory[addr] = value;
                this.enabled = (value & 0x80) == 0 ? false : true;
                if (!this.enabled) {
                    for (var i = 0xFF10; i < 0xFF27; i++)
                        this.memory[i] = 0;
                }
                break;
        }
    }
    APU.registers = {
        NR52: 0xFF26,
        NR50: 0xFF24,
        NR51: 0xFF25
    };
    GameboyJS.APU = APU;

    // Channel1 class
    var Channel1 = function(apu, channelNumber, audioContext) {
        this.apu = apu;
        this.channelNumber = channelNumber;
        this.playing = false;

        this.soundLengthUnit = 0x4000; 
        this.soundLength = 64; 
        this.lengthCheck = false;

        this.clockLength = 0;
        this.clockEnvelop = 0;
        this.clockSweep = 0;

        var gainNode = audioContext.createGain();
        gainNode.gain.value = 0;
        var oscillator = audioContext.createOscillator();
        oscillator.type = 'square';
        oscillator.frequency.value = 1000;
        oscillator.connect(gainNode);
        oscillator.start(0);

        this.audioContext = audioContext;
        this.gainNode = gainNode;
        this.oscillator = oscillator;
    }

    Channel1.prototype.play = function() {
        if (this.playing) return;
        this.playing = true;
        this.apu.setSoundFlag(this.channelNumber, 1);
        this.gainNode.connect(this.audioContext.destination);
        this.clockLength = 0;
        this.clockEnvelop = 0;
        this.clockSweep = 0;
        if (this.sweepShifts > 0) this.checkFreqSweep();
    }
    Channel1.prototype.stop = function() {
        this.playing = false;
        this.apu.setSoundFlag(this.channelNumber, 0);
        this.gainNode.disconnect();
    }
    Channel1.prototype.checkFreqSweep = function() {
        var oldFreq = this.getFrequency();
        var newFreq = oldFreq + this.sweepSign * (oldFreq >> this.sweepShifts);
        if (newFreq > 0x7FF) {
            newFreq = 0;
            this.stop();
        }

        return newFreq;
    }
    Channel1.prototype.update = function(clockElapsed) {
        this.clockEnvelop += clockElapsed;
        this.clockSweep   += clockElapsed;

        if ((this.sweepCount || this.sweepTime) && this.clockSweep > (this.sweepStepLength * this.sweepTime)) {
            this.clockSweep -= (this.sweepStepLength * this.sweepTime);
            this.sweepCount--;

            var newFreq = this.checkFreqSweep(); 

            this.apu.memory[0xFF13] = newFreq & 0xFF;
            this.apu.memory[0xFF14] &= 0xF8;
            this.apu.memory[0xFF14] |= (newFreq & 0x700) >> 8;
            this.setFrequency(newFreq);

            this.checkFreqSweep(); 
        }

        if (this.envelopeCheck && this.clockEnvelop > this.envelopeStepLength) {
            this.clockEnvelop -= this.envelopeStepLength;
            this.envelopeStep--;
            this.setEnvelopeVolume(this.envelopeVolume + this.envelopeSign);
            if (this.envelopeStep <= 0) {
                this.envelopeCheck = false;
            }
        }

        if (this.lengthCheck) {
            this.clockLength += clockElapsed;
            if (this.clockLength > this.soundLengthUnit) {
                this.soundLength--;
                this.clockLength -= this.soundLengthUnit;
                if (this.soundLength == 0) {
                    this.setLength(0);
                    this.stop();
                }
            }
        }
    }
    Channel1.prototype.setFrequency = function(value) {
        this.frequency = value;
        this.oscillator.frequency.value = 131072 / (2048 - this.frequency);
    }
    Channel1.prototype.getFrequency = function() {
        return this.frequency;
    }
    Channel1.prototype.setLength = function(value) {
        this.soundLength = 64 - (value & 0x3F);
    }
    Channel1.prototype.setEnvelopeVolume = function(volume) {
        this.envelopeCheck = volume > 0 && volume < 16 ? true : false;
        this.envelopeVolume = volume;
        this.gainNode.gain.value = this.envelopeVolume * 1/100;
    }
    Channel1.prototype.disable = function() {
        this.oscillator.disconnect();
    }
    Channel1.prototype.enable = function() {
        this.oscillator.connect(this.gainNode);
    }
    GameboyJS.Channel1 = Channel1;

    // Channel3 class
    var Channel3 = function(apu, channelNumber, audioContext) {
        this.apu = apu;
        this.channelNumber = channelNumber;
        this.playing = false;

        this.soundLength = 0;
        this.soundLengthUnit = 0x4000; 
        this.lengthCheck = false;

        this.clockLength = 0;

        this.buffer = new Float32Array(32);

        var gainNode = audioContext.createGain();
        gainNode.gain.value = 1;
        this.gainNode = gainNode;

        this.baseSpeed = 65536;
        var waveBuffer = audioContext.createBuffer(1, 32, this.baseSpeed);

        var bufferSource = audioContext.createBufferSource();
        bufferSource.buffer = waveBuffer;
        bufferSource.loop = true;
        bufferSource.connect(gainNode);
        bufferSource.start(0);

        this.audioContext = audioContext;
        this.waveBuffer = waveBuffer;
        this.bufferSource = bufferSource;

    }

    Channel3.prototype.play = function() {
        if (this.playing) return;
        this.playing = true;
        this.apu.setSoundFlag(this.channelNumber, 1);
        this.waveBuffer.copyToChannel(this.buffer, 0, 0);

        this.gainNode.connect(this.audioContext.destination);
        this.clockLength = 0;
    }
    Channel3.prototype.stop = function() {
        this.playing = false;
        this.apu.setSoundFlag(this.channelNumber, 0);
        this.gainNode.disconnect();
    }
    Channel3.prototype.update = function(clockElapsed) {
        if (this.lengthCheck){
            this.clockLength  += clockElapsed;
            if (this.clockLength > this.soundLengthUnit) {
                this.soundLength--;
                this.clockLength -= this.soundLengthUnit;
                if (this.soundLength == 0) {
                    this.setLength(0);
                    this.stop();
                }
            }
        }
    }
    Channel3.prototype.setFrequency = function(value) {
        value = 65536 / (2048  - value);
        this.bufferSource.playbackRate.value = value / this.baseSpeed;
    }
    Channel3.prototype.getFrequency = function() {
        var freq = 2048 - 65536 / (this.bufferSource.playbackRate.value * this.baseSpeed);
        return freq | 1;
    }
    Channel3.prototype.setLength = function(value) {
        this.soundLength = 256 - value;
    }
    Channel3.prototype.setWaveBufferByte = function(index, value) {
        var bufferIndex = index * 2;

        this.buffer[bufferIndex]   = (value >> 4) / 8 - 1; 
        this.buffer[bufferIndex+1] = (value & 0x0F) / 8 - 1;
    }
    Channel3.prototype.disable = function() {
        this.bufferSource.disconnect();
    }
    Channel3.prototype.enable = function() {
        this.bufferSource.connect(this.gainNode);
    }
    GameboyJS.Channel3 = Channel3;

    // Channel4 class
    var Channel4 = function(apu, channelNumber, audioContext) {
        this.apu = apu;
        this.channelNumber = channelNumber;
        this.playing = false;

        this.soundLengthUnit = 0x4000; 
        this.soundLength = 64; 
        this.lengthCheck = false;

        this.clockLength = 0;

        this.audioContext = audioContext;
    }

    Channel4.prototype.play = function() {
        if (this.playing) return;
        this.playing = true;
        this.apu.setSoundFlag(this.channelNumber, 1);
        this.clockLength = 0;
    }
    Channel4.prototype.stop = function() {
        this.playing = false;
        this.apu.setSoundFlag(this.channelNumber, 0);
    }
    Channel4.prototype.update = function(clockElapsed) {
        if (this.lengthCheck) {
            this.clockLength  += clockElapsed;
            if (this.clockLength > this.soundLengthUnit) {
                this.soundLength--;
                this.clockLength -= this.soundLengthUnit;
                if (this.soundLength == 0) {
                    this.setLength(0);
                    this.stop();
                }
            }
        }
    }
    Channel4.prototype.setLength = function(value) {
        this.soundLength = 64 - (value & 0x3F);
    }
    GameboyJS.Channel4 = Channel4;

    // Timer class
    var Timer = function(cpu, memory) {
        this.cpu    = cpu;
        this.memory = memory;

        this.DIV  = 0xFF04;
        this.TIMA = 0xFF05;
        this.TMA  = 0xFF06;
        this.TAC  = 0xFF07;

        this.mainTime  = 0;
        this.divTime   = 0;
    }

    Timer.prototype.update = function(clockElapsed) {
        this.updateDiv(clockElapsed);
        this.updateTimer(clockElapsed);
    }

    Timer.prototype.updateTimer = function(clockElapsed) {
        if (!(this.memory.rb(this.TAC) & 0x4)) {
            return;
        }
        this.mainTime += clockElapsed;

        var threshold = 64;
        switch (this.memory.rb(this.TAC) & 3) {
            case 0: threshold=64; break; 
            case 1: threshold=1;  break; 
            case 2: threshold=4;  break; 
            case 3: threshold=16; break; 
        }
        threshold *= 16;

        while (this.mainTime >= threshold) {
            this.mainTime -= threshold;

            this.memory.wb(this.TIMA, this.memory.rb(this.TIMA) + 1);
            if (this.memory.rb(this.TIMA) > 0xFF) {
                this.memory.wb(this.TIMA, this.memory.rb(this.TMA));
                this.cpu.requestInterrupt(GameboyJS.CPU.INTERRUPTS.TIMER);
            }
        }
    }
    Timer.prototype.updateDiv = function(clockElapsed) {
        var divThreshold = 256; 
        this.divTime += clockElapsed;
        if (this.divTime > divThreshold) {
            this.divTime -= divThreshold;
            var div = this.memory.rb(this.DIV) + 1;
            this.memory.wb(this.DIV, div&0xFF);
        }
    }

    Timer.prototype.resetDiv = function() {
        this.divTime = 0;
        this.memory[this.DIV] = 0; 
    }
    GameboyJS.Timer = Timer;

    // Memory class
    var Memory = function(cpu) {
        this.MEM_SIZE = 65536; 

        this.MBCtype = 0;
        this.banksize = 0x4000;
        this.rom = null;
        this.mbc = null;
        this.cpu = cpu;
    }

    Memory.prototype.reset = function() {
        this.length = this.MEM_SIZE;
        for (var i = Memory.addresses.VRAM_START; i <= Memory.addresses.VRAM_END; i++) {
            this[i] = 0;
        }
        for (var i = Memory.addresses.DEVICE_START; i <= Memory.addresses.DEVICE_END; i++) {
            this[i] = 0;
        }
        this[0xFFFF] = 0;
    }

    Memory.prototype.setRomData = function(data) {
        this.rom = data;
        this.loadRomBank(0);
        this.mbc = GameboyJS.MBC.getMbcInstance(this, this[0x147]);
        this.loadRomBank(1);
        this.mbc.loadRam(this.cpu.getGameName(), this.cpu.getRamSize());
    }

    Memory.prototype.loadRomBank = function(index) {
        var start = index ? 0x4000 : 0x0;
        var romStart = index * 0x4000;
        for (var i = 0; i < this.banksize; i++) {
            this[i + start] = this.rom[romStart + i];
        }
    }

    Memory.prototype.vram = function(address) {
        if (address < Memory.addresses.VRAM_START || address > Memory.addresses.VRAM_END) {
            throw 'VRAM access in out of bounds address ' + address;
        }

        return this[address];
    }

    Memory.prototype.oamram = function(address) {
        if (address < Memory.addresses.OAM_START || address > Memory.addresses.OAM_END) {
            throw 'OAMRAM access in out of bounds address ' + address;
        }

        return this[address];
    }

    Memory.prototype.deviceram = function(address, value) {
        if (address < Memory.addresses.DEVICERAM_START || address > Memory.addresses.DEVICERAM_END) {
            throw 'Device RAM access in out of bounds address ' + address;
        }
        if (typeof value === "undefined") {
            return this[address];
        } else {
            this[address] = value;
        }

    }

    Memory.prototype.rb = function(addr) {
        if (addr >= 0xFF10 && addr < 0xFF40) {
            var mask = apuMask[addr - 0xFF10];
            return this[addr] | mask;
        }
        if ((addr >= 0xA000 && addr < 0xC000)) {
            return this.mbc.readRam(addr);
        }
        return this[addr];
    }

    Memory.prototype.wb = function(addr, value) {
        if (addr < 0x8000 || (addr >= 0xA000 && addr < 0xC000)) { 
            this.mbc.manageWrite(addr, value);
        } else if (addr >= 0xFF10 && addr <= 0xFF3F) { 
            this.cpu.apu.manageWrite(addr, value);
        } else if (addr == 0xFF00) { 
            this[addr] = ((this[addr] & 0x0F) | (value & 0x30));
        } else {
            this[addr] = value;
            if ((addr & 0xFF00) == 0xFF00) {
                if (addr == 0xFF02) {
                    if (value & 0x80) {
                        this.cpu.enableSerialTransfer();
                    }
                }
                if (addr == 0xFF04) {
                    this.cpu.resetDivTimer();
                }
                if (addr == 0xFF46) { 
                    this.dmaTransfer(value);
                }
            }
        }
    }

    Memory.prototype.dmaTransfer = function(startAddressPrefix) {
        var startAddress = (startAddressPrefix << 8);
        for (var i = 0; i < 0xA0; i++) {
            this[Memory.addresses.OAM_START + i] = this[startAddress + i];
        }
    }
    Memory.addresses = {
        VRAM_START: 0x8000,
        VRAM_END: 0x9FFF,
        OAM_START: 0xFE00,
        OAM_END: 0xFE9F,
        DEVICE_START: 0xFF00,
        DEVICERAM_START: 0xFF00,
        DEVICERAM_END: 0xFF7F,
        DEVICE_END: 0xFF7F
    };
    GameboyJS.Memory = Memory;

    // Util class
    var Util = function() {}

    Util.extend = function(target, source1, source2, etc) {
        var sources = Array.prototype.slice.call(arguments);
        for (var i in sources) {
            var source = sources[i];
            for (var name in source) {
                target[name] = source[name];
            }
        }

        return target;
    };
    Util.testFlag = function(p, cc) {
        var test=1;
        var mask=0x10;
        if (cc=='NZ'||cc=='NC') test=0;
        if (cc=='NZ'||cc=='Z')  mask=0x80;
        return (test && p.r.F&mask) || (!test && !(p.r.F&mask));
    };
    Util.getRegAddr = function(p, r1, r2) {return Util.makeword(p.r[r1], p.r[r2]);};

    Util.makeword = function(b1, b2) {return (b1 << 8) + b2;};

    Util.getSignedValue = function(v) {return v & 0x80 ? v-256 : v;};

    Util.readBit = function(byte, index) {
        return (byte >> index) & 1;
    }
    GameboyJS.Util = Util;

})()