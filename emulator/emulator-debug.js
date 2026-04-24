// Thin shim: connects to the debug adapter, bridges to your real emulator.
// Replace the STUB functions below with calls into your actual emulator.

const statusEl  = document.getElementById('status');
const currentEl = document.getElementById('current');
const logEl     = document.getElementById('log');

function log(msg) {
  logEl.textContent += msg + '\n';
  logEl.scrollTop = logEl.scrollHeight;
}

// ─── State ───────────────────────────────────────────────────────────────
let ws = null;
let breakpoints = new Map();   // file → Set<number>
let currentFile = '';
let currentLine = 1;

const normalizePath = (p) => p.replace(/\\/g, '/').toLowerCase();

// ─── Your emulator hooks ─────────────────────────────────────────────────
// Replace these STUBS with real calls into your emulator.

function emulatorLoad(programPath) {
  log(`[STUB] load: ${programPath}`);
  // TODO: your emulator: fetch/load the assembled program
  // TODO: load source map (PC → file,line)
  // After loading, report "stopped at entry":
  reportStopped(normalizePath(programPath), 1, 'entry');
}

function emulatorRunUntilBreakOrEnd() {
  log('[STUB] continue');
  // TODO: real emulator: run instructions in a loop, checking breakpoints.
  // For now, a dumb stub that advances 5 lines then halts.
  const bps = breakpoints.get(currentFile) ?? new Set();
  for (let i = 0; i < 100; i++) {
    currentLine++;
    if (bps.has(currentLine)) {
      reportStopped(currentFile, currentLine, 'breakpoint');
      return;
    }
  }
  send({ event: 'terminated' });
}

function emulatorStepOne() {
  log('[STUB] step');
  currentLine++;
  reportStopped(currentFile, currentLine, 'step');
}

function fakeRegisters() {
  return {
    d: [0x11111111, 0x22222222, 0, 0, 0, 0, 0, 0],
    a: [0x00100000, 0, 0, 0, 0, 0, 0, 0x00FF0000],
    pc: 0x00001000 + currentLine * 2,
    sr: 0x2000,
  };
}

// ─── Bridge plumbing ─────────────────────────────────────────────────────

function reportStopped(file, line, reason) {
  currentFile = file;
  currentLine = line;
  currentEl.textContent = `${file}:${line}`;
  send({ event: 'stopped', reason, file, line, registers: fakeRegisters() });
}

function send(obj) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(obj));
  }
}

function handleCommand(msg) {
  log(`<< ${msg.cmd}`);
  switch (msg.cmd) {
    case 'load':
      emulatorLoad(msg.program);
      break;
    case 'setBreakpoints':
      breakpoints.set(normalizePath(msg.file), new Set(msg.lines));
      log(`  breakpoints for ${normalizePath(msg.file)}: [${msg.lines.join(', ')}]`);
      break;
    case 'continue':
      emulatorRunUntilBreakOrEnd();
      break;
    case 'stepOver':
    case 'stepIn':
      emulatorStepOne();
      break;
    case 'pause':
      reportStopped(currentFile, currentLine, 'pause');
      break;
  }
}

function connect() {
  ws = new WebSocket('ws://localhost:9229');
  ws.onopen = () => {
    statusEl.textContent = 'Connected to debug adapter';
    statusEl.className = 'connected';
    log('[connected]');
  };
  ws.onmessage = (ev) => {
    try { handleCommand(JSON.parse(ev.data)); }
    catch (err) { log('Parse error: ' + err); }
  };
  ws.onclose = () => {
    statusEl.textContent = 'Disconnected (retrying…)';
    statusEl.className = 'disconnected';
    setTimeout(connect, 1000);
  };
  ws.onerror = () => {
    // onclose will handle reconnection.
  };
}

connect();
