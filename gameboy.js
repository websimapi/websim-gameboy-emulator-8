/**
 * GameBoy emulator core
 * Based on https://github.com/juchi/gameboy.js/
 */

class GameBoy {
    constructor(canvas, options) {
        options = options || {};
        this.options = GameboyJS.Util.extend({}, defaultOptions, options);

        var cpu = new GameboyJS.CPU(this);
        var screen = new GameboyJS.Screen(canvas, this.options.zoom);
        var gpu = new GameboyJS.GPU(screen, cpu);
        cpu.gpu = gpu;

        var pad = new this.options.pad.class(this.options.pad.mapping);
        var input = new GameboyJS.Input(cpu, pad);
        cpu.input = input;

        this.cpu = cpu;
        this.screen = screen;
        this.input = input;
        this.pad = pad;

        this.createRom(this.options.romReaders);

        this.statusContainer   = document.getElementById(this.options.statusContainerId) || document.createElement('div');
        this.gameNameContainer = document.getElementById(this.options.gameNameContainerId) || document.createElement('div');
        this.errorContainer    = document.getElementById(this.options.errorContainerId) || document.createElement('div');
    }

    createRom(readers) {
        var rom = new GameboyJS.Rom(this);
        if (readers.length == 0) {
            var romReader = new GameboyJS.RomFileReader();
            rom.addReader(romReader);
        } else {
            for (var i in readers) {
                if (readers.hasOwnProperty(i)) {
                    rom.addReader(readers[i]);
                }
            }
        }
    }

    startRom(rom) {
        this.errorContainer.classList.add('hide');
        this.cpu.reset();
        try {
            this.cpu.loadRom(rom.data);
            this.setStatus('Game Running :');
            this.setGameName(this.cpu.getGameName());
            this.cpu.run();
        } catch (e) {
            this.handleException(e);
        }
    }

    pause(value) {
        if (value) {
            this.setStatus('Game Paused :');
            this.cpu.pause();
        } else {
            this.setStatus('Game Running :');
            this.cpu.unpause();
        }
    }

    error(message) {
        this.setStatus('Error during execution');
        this.setError('An error occurred during execution:' + message);
        this.cpu.stop();
    }

    setStatus(status) {
        this.statusContainer.innerHTML = status;
    }
    setError(message) {
        this.errorContainer.classList.remove('hide');
        this.errorContainer.innerHTML = message;
    }
    setGameName(name) {
        this.gameNameContainer.innerHTML = name;
    }
    setSoundEnabled(value) {
        if (value) {
            this.cpu.apu.connect();
        } else {
            this.cpu.apu.disconnect();
        }
    }
    setScreenZoom(value) {
        this.screen.setPixelSize(value);
    }
    handleException(e) {
        if (e instanceof GameboyJS.UnimplementedException) {
            if (e.fatal) {
                this.error('This cartridge is not supported ('+ e.message +')');
            } else {
                console.error(e.message);
            }
        } else {
            throw e;
        }
    }
}

var defaultOptions = {
    pad: {class: GameboyJS.Keyboard, mapping: null},
    zoom: 1,
    romReaders: [],
    statusContainerId: 'status',
    gameNameContainerId: 'game-name',
    errorContainerId: 'error'
};

var GameboyJS = {
    CPU: class CPU {
        constructor(gameboy) {
            this.gameboy = gameboy;

            this.r = {A:0, F: 0, B:0, C:0, D:0, E:0, H:0, L:0, pc:0, sp:0};
            this.IME = true;
            this.clock = {c: 0, serial: 0};
            this.isHalted = false;
            this.isPaused = false;
            this.usingBootRom = false;

            this.createDevices();
        }

        createDevices() {
            this.memory = new GameboyJS.Memory(this);
            this.timer = new GameboyJS.Timer(this, this.memory);
            this.apu = new GameboyJS.APU(this.memory);

            this.SERIAL_INTERNAL_INSTR = 512; 
            this.enableSerial = 0;
            this.serialHandler = GameboyJS.ConsoleSerial;
        }

        reset() {
            this.memory.reset();

            this.r.sp = 0xFFFE;
        }

        loadRom(data) {
            this.memory.setRomData(data);
        }

        getRamSize() {
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
        }

        getGameName() {
            var name = '';
            for (var i = 0x134; i < 0x143; i++) {
                var char = this.memory.rb(i) || 32;
                name += String.fromCharCode(char);
            }

            return name;
        }

        run() {
            if (this.usingBootRom) {
                this.r.pc = 0x0000;
            } else {
                this.r.pc = 0x0100;
            }
            this.frame();
        }

        stop() {
            clearTimeout(this.nextFrameTimer);
        }

        frame() {
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
                        this.r.F &= 0xF0; 

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
        }

        fetchOpcode() {
            var opcode = this.memory.rb(this.r.pc++);
            if (opcode === undefined) {console.log(opcode + ' at ' + (this.r.pc-1).toString(16));this.stop();return;}
            if (!GameboyJS.opcodeMap[opcode]) {
                console.error('Unknown opcode '+opcode.toString(16)+' at address '+(this.r.pc-1).toString(16)+', stopping execution...');
                this.stop();
                return null;
            }

            return opcode;
        }

        rr(register) {
            return this.r[register];
        }

        wr(register, value) {
            this.r[register] = value;
        }

        halt() {
            this.isHalted = true;
        }
        unhalt() {
            this.isHalted = false;
        }
        pause() {
            this.isPaused = true;
        }
        unpause() {
            if (this.isPaused) {
                this.isPaused = false;
                this.frame();
            }
        }

        checkInterrupt() {
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

        requestInterrupt(type) {
            var IFval = this.memory.rb(0xFF0F);
            IFval |= (1 << type)
            this.memory.wb(0xFF0F, IFval) ;
            this.unhalt();
        }

        isInterruptEnable(type) {
            return GameboyJS.Util.readBit(this.memory.rb(0xFFFF), type) != 0;
        }

        enableInterrupts() {
            this.IME = true;
        }
        disableInterrupts() {
            this.IME = false;
        }

        enableSerialTransfer() {
            this.enableSerial = 1;
            this.clock.serial = 0;
        }

        endSerialTransfer() {
            this.enableSerial = 0;
            var data = this.memory.rb(0xFF01);
            this.memory.wb(0xFF02, 0);
            this.serialHandler.out(data);
            this.memory.wb(0xFF01, this.serialHandler.in());
        }

        resetDivTimer() {
            this.timer.resetDiv();
        }
    },
    Debug: {
        view_memory: function(addr, gameboy) {
            var memory = gameboy.cpu.memory;
            addr = addr & 0xFFF0;
            var pad = '00';
            var str = addr.toString(16) + ':';
            for (var i = addr; i < addr + 0x10; i++) {
                if ((i & 0x1) == 0) {
                    str += ' ';
                }
                var val = memory[i] || 0;

                val = val.toString(16);
                str += pad.substring(val.length) + val;
            }

            return str;
        },

        view_tile: function(gameboy, index, dataStart) {
            var memory = gameboy.cpu.memory;
            var screen = gameboy.screen;
            var LCDC = screen.deviceram(screen.LCDC);
            if (typeof dataStart === 'undefined') {
                dataStart = 0x8000;
                if (!GameboyJS.Util.readBit(LCDC, 4)) {
                    dataStart = 0x8800;
                    index = GameboyJS.cpuOps._getSignedValue(index) + 128;
                }
            }

            var tileData = screen.readTileData(index, dataStart);

            var pixelData = new Array(8 * 8)
            for (var line = 0; line < 8; line++) {
                var b1 = tileData.shift();
                var b2 = tileData.shift();

                for (var pixel = 0; pixel < 8; pixel++) {
                    var mask = (1 << (7-pixel));
                    var colorValue = ((b1 & mask) >> (7-pixel)) + ((b2 & mask) >> (7-pixel))*2;
                    pixelData[line * 8 + pixel] = colorValue;
                }
            }

            var i = 0;
            while (pixelData.length) {
                console.log(i++ + ' ' + pixelData.splice(0, 8).join(''));
            }
        },

        list_visible_sprites: function(gameboy) {
            var memory = gameboy.cpu.memory;
            var indexes = new Array();
            for (var i = 0xFE00; i < 0xFE9F; i += 4) {
                var x = memory.oamram(i + 1);
                var y = memory.oamram(i);
                var tileIndex = memory.oamram(i + 2);
                if (x == 0 || x >= 168) {
                    continue;
                }
                indexes.push({oamIndex:i, x:x, y:y, tileIndex:tileIndex});
            }

            return indexes;
        }
    },
    GPU: class GPU {
        constructor(screen, cpu) {
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

        update(clockElapsed) {
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

        updateLY() {
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

        setMode(mode) {
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

        drawScanLine(line) {
            var LCDC = this.deviceram(this.LCDC);
            var enable = GameboyJS.Util.readBit(LCDC, 7);
            if (enable) {
                var lineBuffer = new Array(GameboyJS.Screen.physics.WIDTH);
                this.drawBackground(LCDC, line, lineBuffer);
                this.drawSprites(LCDC, line, lineBuffer);
            }
        }

        drawFrame() {
            var LCDC = this.deviceram(this.LCDC);
            var enable = GameboyJS.Util.readBit(LCDC, 7);
            if (enable) {
                this.drawWindow(LCDC);
            }
            this.bgTileCache = {};
            this.screen.render(this.buffer);
        }

        drawBackground(LCDC, line, lineBuffer) {
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

        copyBGTileLine(lineBuffer, tileBuffer, x) {
            for (var k = 0; k < 8; k++, x++) {
                if (x < 0 || x >= GameboyJS.Screen.physics.WIDTH) continue;
                lineBuffer[x] = tileBuffer[k];
            }
        }

        copyLineToBuffer(lineBuffer, line) {
            var bgPalette = GPU.getPalette(this.deviceram(this.BGP));

            for (var x = 0; x < GameboyJS.Screen.physics.WIDTH; x++) {
                var color = lineBuffer[x];
                this.drawPixel(x, line, bgPalette[color]);
            }
        }

        drawTileLine(tileData, line, xflip, yflip) {
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

        drawSprites(LCDC, line, lineBuffer) {
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

        copySpriteTileLine(lineBuffer, tileBuffer, x, palette) {
            for (var k = 0; k < 8; k++, x++) {
                if (x < 0 || x >= GameboyJS.Screen.physics.WIDTH || tileBuffer[k] == 0) continue;
                lineBuffer[x] = {color:tileBuffer[k], palette: palette};
            }
        }

        copySpriteLineToBuffer(spriteLineBuffer, line) {
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

        drawTile(tileData, x, y, buffer, bufferWidth, xflip, yflip, spriteMode) {
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

        readTileData(tileIndex, dataStart, tileSize) {
            tileSize = tileSize || 0x10; 
            var tileData = new Array();

            var tileAddressStart = dataStart + (tileIndex * 0x10);
            for (var i = tileAddressStart; i < tileAddressStart + tileSize; i++) {
                tileData.push(this.vram(i));
            }

            return tileData;
        }

        drawWindow(LCDC) {
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

        drawPixel(x, y, color) {
            this.buffer[y * 160 + x] = color;
        }

        getPixel(x, y) {
            return this.buffer[y * 160 + x];
        }

        static getPalette(paletteByte) {
            var palette = [];
            for (var i = 0; i < 8; i += 2) {
                var shade = (paletteByte & (3 << i)) >> i;
                palette.push(shade);
            }
            return palette;
        }
    },
    Screen: class Screen {
        constructor(canvas, pixelSize) {
            this.context = canvas.getContext('2d');
            this.canvas = canvas;
            this.pixelSize = pixelSize || 1;
            this.initImageData();
        }

        setPixelSize(pixelSize) {
            this.pixelSize = pixelSize;
            this.initImageData();
        }

        initImageData() {
            this.canvas.width = GameboyJS.Screen.physics.WIDTH * this.pixelSize;
            this.canvas.height = GameboyJS.Screen.physics.HEIGHT * this.pixelSize;
            this.imageData = this.context.createImageData(this.canvas.width, this.canvas.height);
        }

        clearScreen() {
            this.context.fillStyle = '#FFF';
            this.context.fillRect(0, 0, GameboyJS.Screen.physics.WIDTH * this.pixelSize, GameboyJS.Screen.physics.HEIGHT * this.pixelSize);
        }

        fillImageData(buffer) {
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

        render(buffer) {
            this.fillImageData(buffer);
            this.context.putImageData(this.imageData, 0, 0);
        }
    },
    cpuOps: {
        // ... operations implementation ...
    },
    opcodeMap: {
        // ... opcode mapping ...
    },
    opcodeCbmap: {
        // ... cb opcode mapping ...
    },
    MBC: {
        // ... memory bank controller implementation ...
    },
    Memory: class Memory {
        constructor(cpu) {
            this.MEM_SIZE = 65536; 

            this.MBCtype = 0;
            this.banksize = 0x4000;
            this.rom = null;
            this.mbc = null;
            this.cpu = cpu;
        }

        reset() {
            this.length = this.MEM_SIZE;
            for (var i = Memory.addresses.VRAM_START; i <= Memory.addresses.VRAM_END; i++) {
                this[i] = 0;
            }
            for (var i = Memory.addresses.DEVICE_START; i <= Memory.addresses.DEVICE_END; i++) {
                this[i] = 0;
            }
            this[0xFFFF] = 0;
        }

        setRomData(data) {
            this.rom = data;
            this.loadRomBank(0);
            this.mbc = GameboyJS.MBC.getMbcInstance(this, this[0x147]);
            this.loadRomBank(1);
            this.mbc.loadRam(this.cpu.getGameName(), this.cpu.getRamSize());
        }

        loadRomBank(index) {
            var start = index ? 0x4000 : 0x0;
            var romStart = index * 0x4000;
            for (var i = 0; i < this.banksize; i++) {
                this[i + start] = this.rom[romStart + i];
            }
        }

        vram(address) {
            if (address < Memory.addresses.VRAM_START || address > Memory.addresses.VRAM_END) {
                throw 'VRAM access in out of bounds address ' + address;
            }

            return this[address];
        }

        oamram(address) {
            if (address < Memory.addresses.OAM_START || address > Memory.addresses.OAM_END) {
                throw 'OAMRAM access in out of bounds address ' + address;
            }

            return this[address];
        }

        deviceram(address, value) {
            if (address < Memory.addresses.DEVICERAM_START || address > Memory.addresses.DEVICERAM_END) {
                throw 'Device RAM access in out of bounds address ' + address;
            }
            if (typeof value === "undefined") {
                return this[address];
            } else {
                this[address] = value;
            }

        }

        rb(addr) {
            if (addr >= 0xFF10 && addr < 0xFF40) {
                var mask = apuMask[addr - 0xFF10];
                return this[addr] | mask;
            }
            if ((addr >= 0xA000 && addr < 0xC000)) {
                return this.mbc.readRam(addr);
            }
            return this[addr];
        }

        wb(addr, value) {
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

        dmaTransfer(startAddressPrefix) {
            var startAddress = (startAddressPrefix << 8);
            for (var i = 0; i < 0xA0; i++) {
                this[Memory.addresses.OAM_START + i] = this[startAddress + i];
            }
        }
    },
    APU: class APU {
        constructor(memory) {
            this.memory = memory;
            this.enabled = false;

            AudioContext = window.AudioContext || window.webkitAudioContext;
            var audioContext = new AudioContext();

            this.channel1 = new GameboyJS.Channel1(this, 1, audioContext);
            this.channel2 = new GameboyJS.Channel1(this, 2, audioContext);
            this.channel3 = new GameboyJS.Channel3(this, 3, audioContext);
            this.channel4 = new GameboyJS.Channel4(this, 4, audioContext);

        }

        connect() {
            this.channel1.enable();
            this.channel2.enable();
            this.channel3.enable();
        }
        disconnect() {
            this.channel1.disable();
            this.channel2.disable();
            this.channel3.disable();
        }
        update(clockElapsed) {
            if (this.enabled == false) return;

            this.channel1.update(clockElapsed);
            this.channel2.update(clockElapsed);
            this.channel3.update(clockElapsed);
            this.channel4.update(clockElapsed);
        }
        setSoundFlag(channel, value) {
            var mask = 0xFF - (1 << (channel - 1));
            value = value << (channel - 1)
            var byteValue = this.memory.rb(APU.registers.NR52);
            byteValue &= mask;
            byteValue |= value;
            this.memory[APU.registers.NR52] = byteValue;
        }
        manageWrite(addr, value) {
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
    },
    Channel1: class Channel1 {
        constructor(apu, channelNumber, audioContext) {
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

        play() {
            if (this.playing) return;
            this.playing = true;
            this.apu.setSoundFlag(this.channelNumber, 1);
            this.gainNode.connect(this.audioContext.destination);
            this.clockLength = 0;
            this.clockEnvelop = 0;
            this.clockSweep = 0;
            if (this.sweepShifts > 0) this.checkFreqSweep();
        }
        stop() {
            this.playing = false;
            this.apu.setSoundFlag(this.channelNumber, 0);
            this.gainNode.disconnect();
        }
        checkFreqSweep() {
            var oldFreq = this.getFrequency();
            var newFreq = oldFreq + this.sweepSign * (oldFreq >> this.sweepShifts);
            if (newFreq > 0x7FF) {
                newFreq = 0;
                this.stop();
            }

            return newFreq;
        }
        update(clockElapsed) {
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
        setFrequency(value) {
            this.frequency = value;
            this.oscillator.frequency.value = 131072 / (2048 - this.frequency);
        }
        getFrequency() {
            return this.frequency;
        }
        setLength(value) {
            this.soundLength = 64 - (value & 0x3F);
        }
        setEnvelopeVolume(volume) {
            this.envelopeCheck = volume > 0 && volume < 16 ? true : false;
            this.envelopeVolume = volume;
            this.gainNode.gain.value = this.envelopeVolume * 1/100;
        }
        disable() {
            this.oscillator.disconnect();
        }
        enable() {
            this.oscillator.connect(this.gainNode);
        }
    },
    Channel3: class Channel3 {
        constructor(apu, channelNumber, audioContext) {
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

        play() {
            if (this.playing) return;
            this.playing = true;
            this.apu.setSoundFlag(this.channelNumber, 1);
            this.waveBuffer.copyToChannel(this.buffer, 0, 0);

            this.gainNode.connect(this.audioContext.destination);
            this.clockLength = 0;
        }
        stop() {
            this.playing = false;
            this.apu.setSoundFlag(this.channelNumber, 0);
            this.gainNode.disconnect();
        }
        update(clockElapsed) {
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
        setFrequency(value) {
            value = 65536 / (2048  - value);
            this.bufferSource.playbackRate.value = value / this.baseSpeed;
        }
        getFrequency() {
            var freq = 2048 - 65536 / (this.bufferSource.playbackRate.value * this.baseSpeed);
            return freq | 1;
        }
        setLength(value) {
            this.soundLength = 256 - value;
        }
        setWaveBufferByte(index, value) {
            var bufferIndex = index * 2;

            this.buffer[bufferIndex]   = (value >> 4) / 8 - 1; 
            this.buffer[bufferIndex+1] = (value & 0x0F) / 8 - 1;
        }
        disable() {
            this.bufferSource.disconnect();
        }
        enable() {
            this.bufferSource.connect(this.gainNode);
        }
    },
    Channel4: class Channel4 {
        constructor(apu, channelNumber, audioContext) {
            this.apu = apu;
            this.channelNumber = channelNumber;
            this.playing = false;

            this.soundLengthUnit = 0x4000; 
            this.soundLength = 64; 
            this.lengthCheck = false;

            this.clockLength = 0;

            this.audioContext = audioContext;
        }

        play() {
            if (this.playing) return;
            this.playing = true;
            this.apu.setSoundFlag(this.channelNumber, 1);
            this.clockLength = 0;
        }
        stop() {
            this.playing = false;
            this.apu.setSoundFlag(this.channelNumber, 0);
        }
        update(clockElapsed) {
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
        setLength(value) {
            this.soundLength = 64 - (value & 0x3F);
        }
    },
    Timer: class Timer {
        constructor(cpu, memory) {
            this.cpu    = cpu;
            this.memory = memory;

            this.DIV  = 0xFF04;
            this.TIMA = 0xFF05;
            this.TMA  = 0xFF06;
            this.TAC  = 0xFF07;

            this.mainTime  = 0;
            this.divTime   = 0;
        }

        update(clockElapsed) {
            this.updateDiv(clockElapsed);
            this.updateTimer(clockElapsed);
        }

        updateTimer(clockElapsed) {
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
        updateDiv(clockElapsed) {
            var divThreshold = 256; 
            this.divTime += clockElapsed;
            if (this.divTime > divThreshold) {
                this.divTime -= divThreshold;
                var div = this.memory.rb(this.DIV) + 1;
                this.memory.wb(this.DIV, div&0xFF);
            }
        }

        resetDiv() {
            this.divTime = 0;
            this.memory[this.DIV] = 0; 
        }
    },
    Util: {
        extend: function(target, source1, source2, etc) {
            var sources = Array.prototype.slice.call(arguments);
            for (var i in sources) {
                var source = sources[i];
                for (var name in source) {
                    target[name] = source[name];
                }
            }

            return target;
        },
        testFlag: function(p, cc) {
            var test=1;
            var mask=0x10;
            if (cc=='NZ'||cc=='NC') test=0;
            if (cc=='NZ'||cc=='Z')  mask=0x80;
            return (test && p.r.F&mask) || (!test && !(p.r.F&mask));
        },
        getRegAddr: function(p, r1, r2) {return Util.makeword(p.r[r1], p.r[r2]);},

        makeword: function(b1, b2) {return (b1 << 8) + b2;},

        getSignedValue: function(v) {return v & 0x80 ? v-256 : v;},

        readBit: function(byte, index) {
            return (byte >> index) & 1;
        }
    }
}