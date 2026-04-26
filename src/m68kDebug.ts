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
  private variableHandles = new Handles<'data' | 'address' | 'status'>();

  // Latest state from the emulator — updated on every 'stopped' event.
  private currentFile = '';
  private currentLine = 1;
  private regs: Registers = { d: new Array(8).fill(0), a: new Array(8).fill(0), pc: 0, sr: 0 };

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

  this.sendResponse(response);

  // Tell VS Code we're ready to receive breakpoints and config.
  this.sendEvent(new InitializedEvent());
}

protected async launchRequest(
  response: DebugProtocol.LaunchResponse,
  args: LaunchArgs
): Promise<void> {
  const port = 9229;
  this.sendEvent(new OutputEvent(`[adapter] launchRequest start\n`, 'console'));

  try {
    await this.client.listen(port);
  } catch (err: any) {
    this.sendErrorResponse(response, 1001,
      `Cannot listen on port ${port}: ${err.message}. Is another debug session running?`);
    return;
  }

  // Hook emulator events.
  this.client.on('stopped', (msg: any) => {
    this.currentFile = msg.file;
    this.currentLine = msg.line;
    if (msg.registers) { this.regs = msg.registers; }
    this.sendEvent(new StoppedEvent(msg.reason ?? 'step', M68kDebugSession.THREAD_ID));
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
  response.body = { threads: [new Thread(M68kDebugSession.THREAD_ID, 'M68K CPU')] };
  this.sendResponse(response);
}

protected stackTraceRequest(
  response: DebugProtocol.StackTraceResponse,
  args: DebugProtocol.StackTraceArguments
): void {
  const name = path.basename(this.currentFile) || 'unknown';
  const source = new Source(name, this.currentFile);
  const frame = new StackFrame(
    1,                   // frame id
    'main',              // function name — you could derive this from your symbol table later
    source,
    this.convertDebuggerLineToClient(this.currentLine),
    1                    // column
  );
  response.body = { stackFrames: [frame], totalFrames: 1 };
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
      new Scope('Status',            this.variableHandles.create('status'),  false),
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
  } else if (kind === 'status') {
    variables = [
      { name: 'PC', value: hex32(this.regs.pc), variablesReference: 0 },
      { name: 'SR', value: hex16(this.regs.sr), variablesReference: 0 },
    ];
  }

  response.body = { variables };
  this.sendResponse(response);
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

