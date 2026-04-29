import {
  LoggingDebugSession, InitializedEvent, StoppedEvent, TerminatedEvent,
  Thread, StackFrame, Source, Scope, Handles, OutputEvent
} from '@vscode/debugadapter';
import { DebugProtocol } from '@vscode/debugprotocol';
import { EmulatorServer, Registers } from './emulatorServer';
import * as path from 'path';

interface LaunchArgs extends DebugProtocol.LaunchRequestArguments {
  program: string;
  emulatorUrl?: string;
  stopOnEntry?: boolean;
}

export class M68kDebugSession extends LoggingDebugSession {
  private static THREAD_ID = 1;
  private configurationDone!: Promise<void>;
  private configurationDoneResolve!: () => void;

  private client = new EmulatorServer();
  private variableHandles = new Handles<'data' | 'address' | 'flags' | 'symbols'>();

  // Latest state from the emulator — updated on every 'stopped' event.
  private currentFile = '';
  private currentLine = 1;
  private regs: Registers = { d: new Array(8).fill(0), a: new Array(8).fill(0), pc: 0, sr: 0, x:0, n:0, z:0, v:0, c:0 };
  private currentStack: Array<{ name: string; file: string; line: number }> = [];
  private currentVariables: Array<{ name: string; value: number; type?: string }> = [];

  public constructor() {
  super('m68k-debug.log');

  this.setDebuggerLinesStartAt1(true);
  this.setDebuggerColumnsStartAt1(true);
  this.configurationDone = new Promise((resolve) => {
    this.configurationDoneResolve = resolve;
  });
}

protected initializeRequest(
  response: DebugProtocol.InitializeResponse,
  args: DebugProtocol.InitializeRequestArguments
): void {
  response.body = response.body ?? {};
  response.body.supportsConfigurationDoneRequest = true;
  response.body.supportsSteppingGranularity = true;
  response.body.supportsStepBack = false;
  response.body.supportsRestartRequest = false;
  response.body.supportsEvaluateForHovers = true;

  this.sendResponse(response);

  // Tell VS Code we're ready to receive breakpoints and config.
  this.sendEvent(new InitializedEvent());
}

protected evaluateRequest(
  response: DebugProtocol.EvaluateResponse,
  args: DebugProtocol.EvaluateArguments
): void {
  const result = this.evaluateExpression(args.expression.trim());

  if (result === undefined) {
    // Don't sendErrorResponse — that pollutes the UI with red error toasts on every hover.
    response.body = { result: '', variablesReference: 0 };
    this.sendResponse(response);
    return;
  }

  response.body = { result, variablesReference: 0 };
  this.sendResponse(response);
}

private evaluateExpression(expr: string): string | undefined {
  if (!expr) {return undefined;}

  // First try simple register names
  const reg = this.lookupRegister(expr);
  if (reg !== undefined) {return this.formatHex32(reg);}


 // Symbol lookup — by default show the value at the symbol's address
  const sym = this.symbols[expr];
  if (sym !== undefined) {
    const value = this.readMemoryAtSymbol(sym);
    return value !== undefined ? this.formatHex32(value) : undefined;
  }


  // Try memory dereference: (A0), (D2), (0x1000), (A6+4)
  const memMatch = expr.match(/^\((.+)\)$/);
  if (memMatch) {
    const addrExpr = memMatch[1].trim();
    const addr = this.evaluateNumeric(addrExpr);
    if (addr !== undefined) {
      // You'd need an emulator-side memory peek; for now, return placeholder
      return `[mem at 0x${addr.toString(16).toUpperCase()}]`;
    }
    return undefined;
  }

  // Arithmetic: D0+4, A6-8, etc.
  const num = this.evaluateNumeric(expr);
  if (num !== undefined) return this.formatHex32(num);

  return undefined;
}

private lookupRegister(name: string): number | undefined {
  const upper = name.toUpperCase();
  const dm = upper.match(/^D([0-7])$/); if (dm) return this.regs.d[+dm[1]];
  const am = upper.match(/^A([0-7])$/); if (am) return this.regs.a[+am[1]];
  if (upper === 'SP' || upper === 'A7') return this.regs.a[7];
  if (upper === 'PC') return this.regs.pc;
  if (upper === 'SR') return this.regs.sr;
  return undefined;
}

/**
 * Tiny expression evaluator: register | hex literal | dec literal | + | -
 * Returns undefined for syntax it doesn't understand.
 */
private evaluateNumeric(expr: string): number | undefined {
  // Tokenize into operands and +/- operators.
  const tokens = expr.replace(/\s+/g, '').split(/(?=[+-])|(?<=[+-])/);
  if (tokens.length === 0) {return undefined;}

  let total = 0;
  let sign = 1;

  for (const tok of tokens) {
    if (tok === '+') { sign = 1; continue; }
    if (tok === '-') { sign = -1; continue; }

    // Try register
    const reg = this.lookupRegister(tok);
    if (reg !== undefined) {
      total += sign * (reg | 0);   // | 0 keeps it 32-bit signed
      continue;
    }

    // Try hex (0x... or $...)
    const hex = tok.match(/^(?:0x|\$)([0-9a-fA-F]+)$/);
    if (hex) {
      total += sign * parseInt(hex[1], 16);
      continue;
    }

    // Try decimal
    if (/^\d+$/.test(tok)) {
      total += sign * parseInt(tok, 10);
      continue;
    }

    return undefined;  // unknown token
  }

  return total >>> 0;   // wrap to unsigned 32-bit
}

private formatHex32(n: number): string {
  return '0x' + (n >>> 0).toString(16).toUpperCase().padStart(8, '0');
}

private evaluate(expr: string): string | undefined {
  // Simple register lookup: "D0", "A6", "PC", "SR"
  const m = expr.match(/^[DAdaPpSs]\d?$/) || expr.match(/^[Pp][Cc]$|^[Ss][Rr]$/);
  if (!m) {return undefined};

  const e = expr.toUpperCase();
  if (e === 'PC') {return '0x' + this.regs.pc.toString(16).toUpperCase().padStart(8, '0');}
  const dm = e.match(/^D(\d)$/); if (dm) {return '0x' + (this.regs.d[+dm[1]] >>> 0).toString(16).toUpperCase().padStart(8, '0');}
  const am = e.match(/^A(\d)$/); if (am) {return '0x' + (this.regs.a[+am[1]] >>> 0).toString(16).toUpperCase().padStart(8, '0');}
  return undefined;
}

protected async launchRequest(
  response: DebugProtocol.LaunchResponse,
  args: LaunchArgs
): Promise<void> {
  // Validate the program looks like M68K assembly
  if (!args.program?.match(/\.(s|asm|x68|i)$/i)) {
    this.sendErrorResponse(response, 1002,
      `'${args.program}' is not an M68K source file. Open a .s, .asm, .x68, or .i file before pressing F5.`);
    return;
  }


  const port = 9229;
  this.sendEvent(new OutputEvent(`[adapter] launchRequest start\n`, 'console'));

  try {
    await this.client.listen(port);
  } catch (err: any) {
    this.sendErrorResponse(response, 1001,
      `Cannot listen on port ${port}: ${err.message}. Is another debug session running?`);
    return;
  }


  this.client.on('stopped', (msg: any) => {
  this.sendEvent(new OutputEvent(
    `[adapter] stopped: file=${msg.file} line=${msg.line} reason=${msg.reason}\n`,
    'console'
  ));
  this.currentVariables = msg.variables ?? [];
  this.currentFile = msg.file;
  this.currentLine = msg.line;
  if (msg.registers) { this.regs = msg.registers; }
  this.currentStack = msg.stack ?? [];

  const evt = new StoppedEvent(msg.reason ?? 'step', M68kDebugSession.THREAD_ID);
  (evt.body as any).allThreadsStopped = true;
  if (msg.description) (evt.body as any).description = msg.description;
  if (msg.text)        (evt.body as any).text        = msg.text;
  this.sendEvent(evt);
});


  this.client.on('output', (msg: any) => {
    this.sendEvent(new OutputEvent(msg.text + '\n', msg.category ?? 'stdout'));
  });
  this.client.on('terminated', () => {
    this.sendEvent(new TerminatedEvent());
  });
  this.client.on('emulator-disconnected', () => {
    this.sendEvent(new OutputEvent('Emulator disconnected.\n', 'console'));
  });

  this.sendResponse(response);
  this.sendEvent(new OutputEvent(
  `[adapter] before waitForEmulator, ws connected? ${(this.client as any).ws ? 'yes' : 'no'}\n`,
  'console'
));
  this.sendEvent(new OutputEvent(`[adapter] launch responded, waiting for emulator\n`, 'console'));

  // Wait for the emulator to connect (user should open Live Preview).
  try {
    await this.client.waitForEmulator(30_000);
    this.sendEvent(new OutputEvent(`[adapter] past waitForEmulator\n`, 'console'));
  } catch (err: any) {
    this.sendEvent(new OutputEvent(
      `${err.message}. Open the emulator in Live Preview (Ctrl+Shift+P → "Live Preview: Show Preview").\n`,
      'stderr'
    ));
    this.sendEvent(new TerminatedEvent());
    return;
  }

    this.sendEvent(new OutputEvent(`[adapter] emulator connected, awaiting configurationDone\n`, 'console'));
// Now wait for VS Code to finish sending breakpoints + configurationDone.
  await this.configurationDone;

   this.sendEvent(new OutputEvent(`[adapter] configurationDone resolved, sending load\n`, 'console'));
 // Tell emulator to load.
  this.client.load(args.program);

  if (args.stopOnEntry === false) {
    // Wait briefly for the emulator to acknowledge the load (so it's at "entry"
    // before we tell it to continue), then continue.
    this.client.cont();
  }  
}

protected setBreakPointsRequest(
  response: DebugProtocol.SetBreakpointsResponse,
  args: DebugProtocol.SetBreakpointsArguments
): void {
  this.sendEvent(new OutputEvent(`[adapter] setBreakpoints: ${args.source.path} lines=${(args.breakpoints ?? []).map(b => b.line).join(',')}\n`, 'console'));
 
  const sourcePath = args.source.path ?? '';
  const requested = args.breakpoints ?? [];
  const lines = requested.map(bp => this.convertClientLineToDebugger(bp.line));

  this.client.setBreakpoints(sourcePath, lines);

  // We optimistically mark them all verified. A more honest implementation
  // would wait for the emulator to confirm which lines actually have an
  // instruction (using your PC↔line source map).
  response.body = {
    breakpoints: lines.map(line => ({
      verified: true,
      line: this.convertDebuggerLineToClient(line),
    })),
  };
  this.sendResponse(response);
}

protected configurationDoneRequest(
  response: DebugProtocol.ConfigurationDoneResponse,
  args: DebugProtocol.ConfigurationDoneArguments
): void {
  this.sendEvent(new OutputEvent(`[adapter] configurationDoneRequest called\n`, 'console'));
  super.configurationDoneRequest(response, args);
  this.configurationDoneResolve();
}

protected threadsRequest(response: DebugProtocol.ThreadsResponse): void {
  this.sendEvent(new OutputEvent('[adapter] threadsRequest called\n', 'console'));
  response.body = { threads: [new Thread(M68kDebugSession.THREAD_ID, 'M68K CPU')] };
  this.sendResponse(response);
}


protected stackTraceRequest(
  response: DebugProtocol.StackTraceResponse,
  args: DebugProtocol.StackTraceArguments
): void {
  // Build frames from currentStack. If empty, fall back to a single frame
  // with currentFile/currentLine.
  let frames: DebugProtocol.StackFrame[];

  if (this.currentStack.length > 0) {
    frames = this.currentStack.map((f, i) => ({
      id: i + 1,
      name: f.name || '???',
      source: new Source(path.basename(f.file), f.file),
      line: this.convertDebuggerLineToClient(f.line),
      column: 1,
    }));
  } else {
    frames = [{
      id: 1,
      name: 'main',
      source: new Source(path.basename(this.currentFile), this.currentFile),
      line: this.convertDebuggerLineToClient(this.currentLine),
      column: 1,
    } as DebugProtocol.StackFrame];
  }

  response.body = { stackFrames: frames, totalFrames: frames.length };
  this.sendResponse(response);
}


protected scopesRequest(
  response: DebugProtocol.ScopesResponse,
  args: DebugProtocol.ScopesArguments
): void {
  response.body = {
    scopes: [
      new Scope('Data Registers',    this.variableHandles.create('data'),    false),
      new Scope('Address Registers', this.variableHandles.create('address'), false),
      new Scope('Flags',             this.variableHandles.create('flags'),  false),
      new Scope('Symbols',           this.variableHandles.create('symbols'),   false),
    ],
  };
  this.sendResponse(response);
}

protected variablesRequest(
  response: DebugProtocol.VariablesResponse,
  args: DebugProtocol.VariablesArguments
): void {
  const kind = this.variableHandles.get(args.variablesReference);
  const hex32 = (n: number) => '0x' + (n >>> 0).toString(16).toUpperCase().padStart(8, '0');
  const hex16 = (n: number) => '0x' + (n & 0xFFFF).toString(16).toUpperCase().padStart(4, '0');

  let variables: DebugProtocol.Variable[] = [];

  if (kind === 'data') {
    variables = this.regs.d.map((v, i) => ({
      name: `D${i}`, value: hex32(v), variablesReference: 0,
    }));
  } else if (kind === 'address') {
    variables = this.regs.a.map((v, i) => ({
      name: `A${i}`, value: hex32(v), variablesReference: 0,
    }));
  } else if (kind === 'flags') {
    // Decompose SR into individual flag bits
    const sr = this.regs.sr;
    variables = [
      { name: 'X (Extend)',        value: this.regs.x.toString(), variablesReference: 0 },
      { name: 'N (Negative)',      value: this.regs.n.toString(), variablesReference: 0 },
      { name: 'Z (Zero)',          value: this.regs.z.toString(), variablesReference: 0 },
      { name: 'V (Overflow)',      value: this.regs.v.toString(), variablesReference: 0 },
      { name: 'C (Carry)',         value: this.regs.c.toString(), variablesReference: 0 },
    ];
} else if (kind === 'symbols') {
  variables = this.currentVariables.map(v => ({
    name: v.name,
    value: this.formatSymbolValue(v.value, v.type),
    type: v.type,
    variablesReference: 0,
  }));
}
  response.body = { variables };
  this.sendResponse(response);
}

private formatSymbolValue(value: number, type?: string): string {
  switch (type) {
    case 'byte':
      return '0x' + (value & 0xFF).toString(16).toUpperCase().padStart(2, '0');
    case 'word':
      return '0x' + (value & 0xFFFF).toString(16).toUpperCase().padStart(4, '0');
    case 'long':
    default:
      return '0x' + (value >>> 0).toString(16).toUpperCase().padStart(8, '0');
  }
}

private buildWatchVariables(): DebugProtocol.Variable[] {
  return [
    {
      name: 'Mem at A0',
      value: '0x' + this.regs.a[0].toString(16).toUpperCase(),
      variablesReference: this.variableHandles.create('mem-a0' as any),  // or a more specific kind
    },
    {
      name: 'Mem at SP',
      value: '0x' + this.regs.a[7].toString(16).toUpperCase(),
      variablesReference: this.variableHandles.create('mem-sp' as any),
    },
  ];
}

protected continueRequest(response: DebugProtocol.ContinueResponse): void {
  this.client.cont();
  this.sendResponse(response);
}
protected nextRequest(response: DebugProtocol.NextResponse): void {
  this.client.stepOver();
  this.sendResponse(response);
}
protected stepInRequest(response: DebugProtocol.StepInResponse): void {
  this.client.stepIn();
  this.sendResponse(response);
}
protected stepOutRequest(response: DebugProtocol.StepOutResponse): void {
  // If your emulator doesn't implement real step-out, fall back to step-over.
  this.client.stepOver();
  this.sendResponse(response);
}
protected pauseRequest(response: DebugProtocol.PauseResponse): void {
  this.client.pause();
  this.sendResponse(response);
}

protected disconnectRequest(
  response: DebugProtocol.DisconnectResponse,
  args: DebugProtocol.DisconnectArguments
): void {
  this.client.disconnect();
  this.sendResponse(response);
}

}

M68kDebugSession.run(M68kDebugSession);

