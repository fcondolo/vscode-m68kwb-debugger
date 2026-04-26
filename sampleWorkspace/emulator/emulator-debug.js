
  var pluginInterfaceSingleton = null;

  class PluginInterface {
  constructor() {
    if (pluginInterfaceSingleton !== null) {
      return;
    }
    pluginInterfaceSingleton = this;
    let t = this;
    t.ws = null;
    t.breakpoints = new Map();   // file → Set<number>
    t.currentFile = '';
    t.currentLine = 1;
    t.manualDisconnect = false;
  }

  printStatus(_msg) {
    console.log("pluginInterface STATUS msg: " + msg,);

  }

  printCurrent(_msg) {
    console.log("pluginInterface CURRENT msg: " + msg,);

  }

  printLog(_msg) {
    console.log("pluginInterface LOG msg: " + msg,);
  }


  normalizePath(p) {
    return p.replace(/\\/g, '/').toLowerCase();
  }


  // ─── Your emulator hooks ─────────────────────────────────────────────────
  // Replace these STUBS with real calls into your emulator.

  emulatorLoad(programPath) {
    let t = this;;
    t.printLog(`[STUB] load: ${programPath}`);
    // TODO: your emulator: fetch/load the assembled program
    // TODO: load source map (PC → file,line)
    // After loading, report "stopped at entry":
    reportStopped(t.normalizePath(programPath), 1, 'entry');
  }

  emulatorRunUntilBreakOrEnd() {
    let t = this;
    t.printLog('[STUB] continue');
    // TODO: real emulator: run instructions in a loop, checking breakpoints.
    // For now, a dumb stub that advances 5 lines then halts.
    const bps = t.breakpoints.get(t.currentFile) ?? new Set();
    for (let i = 0; i < 100; i++) {
      t.currentLine++;
      if (bps.has(t.currentLine)) {
        reportStopped(t.currentFile, t.currentLine, 'breakpoint');
        return;
      }
    }
    send({ event: 'terminated' });
  }

  emulatorStepOne() {
    let t = this;
    t.printLog('[STUB] step');
    t.currentLine++;
    reportStopped(t.currentFile, t.currentLine, 'step');
  }

  fakeRegisters() {
    return {
      d: [0x11111111, 0x22222222, 0, 0, 0, 0, 0, 0],
      a: [0x00100000, 0, 0, 0, 0, 0, 0, 0x00FF0000],
      pc: 0x00001000 + t.currentLine * 2,
      sr: 0x2000,
    };
  }

  // ─── Bridge plumbing ─────────────────────────────────────────────────────

  reportStopped(file, line, reason) {
    let t = this;
    t.currentFile = file;
    t.currentLine = line;
    t.printCurrent("file: " + file + ", line: " + line);
    send({ event: 'stopped', reason, file, line, registers: fakeRegisters() });
  }

  send(obj) {
    let t = this;
    if (t.ws && t.ws.readyState === WebSocket.OPEN) {
      t.ws.send(JSON.stringify(obj));
    }
  }

  handleCommand(msg) {
    let t = this;
    t.printLog(`<< ${msg.cmd}`);
    switch (msg.cmd) {
      case 'load':
        emulatorLoad(msg.program);
        break;
      case 'setBreakpoints':
        t.breakpoints.set(t.normalizePath(msg.file), new Set(msg.lines));
        t.printLog(`  breakpoints for ${t.normalizePath(msg.file)}: [${msg.lines.join(', ')}]`);
        break;
      case 'continue':
        emulatorRunUntilBreakOrEnd();
        break;
      case 'stepOver':
      case 'stepIn':
        emulatorStepOne();
        break;
      case 'pause':
        reportStopped(t.currentFile, t.currentLine, 'pause');
        break;
    }
  }

  connect() {
    let t =this;
    if (t.ws && (t.ws.readyState === WebSocket.CONNECTING || t.ws.readyState === WebSocket.OPEN)) {
      this.printLog('[already connected or connecting]');
      return;
    }

    t.ws = new WebSocket('ws://localhost:9229');
    t.ws.onopen = () => {
      pluginInterfaceSingleton.printStatus('Connected to debug adapter');
    };
    t.ws.onmessage = (ev) => {
      try { pluginInterfaceSingleton.handleCommand(JSON.parse(ev.data)); }
      catch (err) { pluginInterfaceSingleton.printLog('Parse error: ' + err); }
    };
    ws.onclose = () => {
      pluginInterfaceSingleton.printStatus('Disconnected');
      if (!pluginInterfaceSingleton.manualDisconnect) {
        setTimeout(connect, 1000);
      }
      pluginInterfaceSingleton.manualDisconnect = false;
    };
    t.ws.onerror = () => {
      // onclose will handle reconnection.
    };
  }


  disconnect() {
    let t = this;
    t.manualDisconnect = true;
    t.ws.close();
  }
}