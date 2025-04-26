// GameBoy Emulator Interface
// Based on https://github.com/juchi/gameboy.js/

document.addEventListener('DOMContentLoaded', function() {
    const canvas = document.getElementById('screen');
    const ctx = canvas.getContext('2d');
    const romFileInput = document.getElementById('rom-file');
    const loadRomButton = document.getElementById('load-rom');
    
    // Initialize the GameBoy emulator
    const gameboy = new GameBoy();
    let running = false;
    let animationFrameId = null;
    
    // Key mapping
    const keyMap = {
        'btn-up': GameBoy.JoyPad.UP,
        'btn-down': GameBoy.JoyPad.DOWN,
        'btn-left': GameBoy.JoyPad.LEFT,
        'btn-right': GameBoy.JoyPad.RIGHT,
        'btn-a': GameBoy.JoyPad.A,
        'btn-b': GameBoy.JoyPad.B,
        'btn-select': GameBoy.JoyPad.SELECT,
        'btn-start': GameBoy.JoyPad.START
    };
    
    // Button event handlers
    Object.keys(keyMap).forEach(buttonId => {
        const button = document.getElementById(buttonId);
        button.addEventListener('mousedown', () => gameboy.joypad.keyDown(keyMap[buttonId]));
        button.addEventListener('mouseup', () => gameboy.joypad.keyUp(keyMap[buttonId]));
        button.addEventListener('touchstart', (e) => {
            e.preventDefault();
            gameboy.joypad.keyDown(keyMap[buttonId]);
        });
        button.addEventListener('touchend', (e) => {
            e.preventDefault();
            gameboy.joypad.keyUp(keyMap[buttonId]);
        });
    });
    
    // Keyboard controls
    const keyboardMap = {
        'ArrowUp': GameBoy.JoyPad.UP,
        'ArrowDown': GameBoy.JoyPad.DOWN,
        'ArrowLeft': GameBoy.JoyPad.LEFT,
        'ArrowRight': GameBoy.JoyPad.RIGHT,
        'z': GameBoy.JoyPad.A,      // Z for A button
        'x': GameBoy.JoyPad.B,      // X for B button
        'Shift': GameBoy.JoyPad.SELECT,
        'Enter': GameBoy.JoyPad.START
    };
    
    document.addEventListener('keydown', (e) => {
        const key = e.key;
        if (keyboardMap[key] !== undefined) {
            e.preventDefault();
            gameboy.joypad.keyDown(keyboardMap[key]);
        }
    });
    
    document.addEventListener('keyup', (e) => {
        const key = e.key;
        if (keyboardMap[key] !== undefined) {
            e.preventDefault();
            gameboy.joypad.keyUp(keyboardMap[key]);
        }
    });
    
    // Load ROM function
    function loadRom(romData) {
        stopEmulation();
        gameboy.loadRom(romData);
        startEmulation();
    }
    
    // Start the emulation
    function startEmulation() {
        if (!running) {
            running = true;
            gameboy.start();
            runEmulation();
        }
    }
    
    // Stop the emulation
    function stopEmulation() {
        if (running) {
            running = false;
            gameboy.stop();
            if (animationFrameId) {
                cancelAnimationFrame(animationFrameId);
                animationFrameId = null;
            }
        }
    }
    
    // Run emulation loop
    function runEmulation() {
        if (!running) return;
        
        // Run a few frames
        for (let i = 0; i < 2; i++) {
            gameboy.runFrame();
        }
        
        // Render to canvas
        const screenData = gameboy.getScreen();
        const imgData = ctx.createImageData(160, 144);
        
        for (let i = 0; i < screenData.length; i++) {
            imgData.data[i * 4] = screenData[i];        // R
            imgData.data[i * 4 + 1] = screenData[i];    // G
            imgData.data[i * 4 + 2] = screenData[i];    // B
            imgData.data[i * 4 + 3] = 255;              // A
        }
        
        ctx.putImageData(imgData, 0, 0);
        
        animationFrameId = requestAnimationFrame(runEmulation);
    }
    
    // Load ROM event handlers
    loadRomButton.addEventListener('click', () => {
        if (romFileInput.files.length > 0) {
            const file = romFileInput.files[0];
            const reader = new FileReader();
            
            reader.onload = function(e) {
                const romData = new Uint8Array(e.target.result);
                loadRom(romData);
            };
            
            reader.readAsArrayBuffer(file);
        } else {
            alert('Please select a ROM file first!');
        }
    });
    
    // Initialize the screen
    ctx.fillStyle = '#9bbc0f';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.font = '14px Arial';
    ctx.fillStyle = '#0f380f';
    ctx.textAlign = 'center';
    ctx.fillText('GameBoy Emulator', canvas.width/2, canvas.height/2 - 20);
    ctx.fillText('Please load a ROM file', canvas.width/2, canvas.height/2 + 20);
});

