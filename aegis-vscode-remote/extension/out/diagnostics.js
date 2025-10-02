"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.registerDiagnostics = registerDiagnostics;
const vscode = __importStar(require("vscode"));
const config_1 = require("./config");
const ui_1 = require("./ui");
const platform_1 = require("./platform");
function registerDiagnostics(ctx, getConnection) {
    ctx.subscriptions.push(vscode.commands.registerCommand('aegis.showDiagnostics', () => {
        const settings = (0, config_1.getSettings)();
        const metrics = getConnection()?.getMetrics();
        ui_1.out.show(true);
        ui_1.out.appendLine('[diag] settings=' + JSON.stringify(settings));
        if (metrics) {
            ui_1.out.appendLine('[diag] metrics=' + JSON.stringify(metrics));
        }
        else {
            ui_1.out.appendLine('[diag] metrics=unavailable (no active connection)');
        }
        const ticket = (0, platform_1.getLastProxyTicketSummary)();
        if (ticket) {
            const redacted = { ...ticket, jti: ticket.jti ? ticket.jti.slice(0, 8) + '…' : undefined };
            ui_1.out.appendLine('[diag] ticket=' + JSON.stringify(redacted));
        }
        vscode.window.showInformationMessage('Aegis diagnostics sent to output channel.');
    }));
}
