/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/
/*
 * extension.ts (and activateMockDebug.ts) forms the "plugin" that plugs into VS Code and contains the code that
 * connects VS Code with the debug adapter.
 * 
 * extension.ts contains code for launching the debug adapter in three different ways:
 * - as an external program communicating with VS Code via stdin/stdout,
 * - as a server process communicating with VS Code via sockets or named pipes, or
 * - as inlined code running in the extension itself (default).
 * 
 * Since the code in extension.ts uses node.js APIs it cannot run in the browser.
 */

'use strict';

//import * as Net from 'net';
import * as vscode from 'vscode';
//import { randomBytes } from 'crypto';
//import { tmpdir } from 'os';
//import { join } from 'path';
//import { platform } from 'process';
//import { ProviderResult } from 'vscode';
import { M68kDebugSession } from './m68kDebug';
import { activateM68kDebug } from './activateMockDebug';

/*
 * The compile time flag 'runMode' controls how the debug adapter is run.
 * Please note: the test suite only supports 'external' mode.
 */

export function activate(context: vscode.ExtensionContext) {
  activateM68kDebug(context, new InlineDebugAdapterFactory());
}

class InlineDebugAdapterFactory implements vscode.DebugAdapterDescriptorFactory {
  createDebugAdapterDescriptor(_session: vscode.DebugSession): vscode.ProviderResult<vscode.DebugAdapterDescriptor> {
    return new vscode.DebugAdapterInlineImplementation(new M68kDebugSession());
  }
  dispose() {}
}

export function deactivate() {
	// nothing to do
}



