import { DecorationOptions, Disposable, Range, window } from "vscode";

import { BufferManager } from "./buffer_manager";
import { HighlightConfiguration, HighlightProvider } from "./highlight_provider";
import { Logger } from "./logger";
import { NeovimExtensionRequestProcessable, NeovimRedrawProcessable } from "./neovim_events_processable";
import { calculateEditorColFromVimScreenCol, convertByteNumToCharNum, GridLineEvent } from "./utils";

export interface HighlightManagerSettings {
    highlight: HighlightConfiguration;
    viewportHeight: number;
}

interface GridLineInfo {
    /**
     * Visible top line
     */
    topLine: number;
    /**
     * Visible bottom line
     */
    bottomLine: number;
}

// const LOG_PREFIX = "HighlightManager";

export class HighlightManager implements Disposable, NeovimRedrawProcessable, NeovimExtensionRequestProcessable {
    private disposables: Disposable[] = [];

    private highlightProvider: HighlightProvider;

    private gridLineInfo: Map<number, GridLineInfo> = new Map();

    private commandsDisposables: Disposable[] = [];

    public constructor(
        private logger: Logger,
        private bufferManager: BufferManager,
        private settings: HighlightManagerSettings,
    ) {
        this.highlightProvider = new HighlightProvider(settings.highlight);
        // this.commandsDisposables.push(
        //     commands.registerCommand("editor.action.indentationToTabs", () =>
        //         this.resetHighlight("editor.action.indentationToTabs"),
        //     ),
        // );
        // this.commandsDisposables.push(
        //     commands.registerCommand("editor.action.indentationToSpaces", () =>
        //         this.resetHighlight("editor.action.indentationToSpaces"),
        //     ),
        // );
        // this.commandsDisposables.push(
        //     commands.registerCommand("editor.action.reindentlines", () =>
        //         this.resetHighlight("editor.action.reindentlines"),
        //     ),
        // );
    }

    public dispose(): void {
        this.disposables.forEach((d) => d.dispose());
        this.commandsDisposables.forEach((d) => d.dispose());
    }

    public handleRedrawBatch(batch: [string, ...unknown[]][]): void {
        const gridHLUpdates: Set<number> = new Set();

        for (const [name, ...args] of batch) {
            switch (name) {
                case "hl_attr_define": {
                    // eslint-disable-next-line @typescript-eslint/no-unused-vars
                    for (const [id, uiAttrs, , info] of args as [
                        number,
                        never,
                        never,
                        [{ kind: "ui"; ui_name: string; hi_name: string }],
                    ][]) {
                        if (info && info[0] && info[0].hi_name) {
                            const name = info[0].hi_name;
                            this.highlightProvider.addHighlightGroup(id, name, uiAttrs);
                        }
                    }
                    break;
                }
                case "win_viewport": {
                    // eslint-disable-next-line @typescript-eslint/no-unused-vars
                    for (const [grid, win, topLine, bottomLine, curline, curcol] of args as [
                        number,
                        Window,
                        number,
                        number,
                        number,
                        number,
                    ][]) {
                        this.gridLineInfo.set(grid, { topLine, bottomLine });
                    }
                    break;
                }
                // nvim may not send grid_cursor_goto and instead uses grid_scroll along with grid_line
                case "grid_scroll": {
                    for (const [grid, top, , , , by] of args as [
                        number,
                        number,
                        number,
                        null,
                        number,
                        number,
                        number,
                    ][]) {
                        if (grid === 1) {
                            continue;
                        }
                        // by > 0 - scroll down, must remove existing elements from first and shift row hl left
                        // by < 0 - scroll up, must remove existing elements from right shift row hl right
                        this.highlightProvider.shiftGridHighlights(grid, by, top);
                        gridHLUpdates.add(grid);
                    }
                    break;
                }
                case "grid_line": {
                    // [grid, row, colStart, cells: [text, hlId, repeat]]
                    const gridEvents = args as GridLineEvent[];

                    // eslint-disable-next-line prefer-const
                    for (let [grid, row, colStart, cells] of gridEvents) {
                        if (row > this.lastViewportRow) {
                            continue;
                        }
                        const lineInfo = this.gridLineInfo.get(grid);
                        if (!lineInfo) {
                            continue;
                        }

                        const editor = this.bufferManager.getEditorFromGridId(grid);
                        if (!editor) {
                            continue;
                        }

                        // const topScreenLine = gridConf.cursorLine === 0 ? 0 : gridConf.cursorLine - gridConf.screenLine;
                        const topScreenLine = lineInfo.topLine;
                        const highlightLine = topScreenLine + row;
                        if (highlightLine >= editor.document.lineCount || highlightLine < 0) {
                            if (highlightLine > 0) {
                                this.highlightProvider.cleanRow(grid, row);
                                gridHLUpdates.add(grid);
                            }
                            continue;
                        }
                        const line = editor.document.lineAt(highlightLine).text;
                        const tabSize = editor.options.tabSize as number;
                        const finalStartCol = calculateEditorColFromVimScreenCol(line, colStart, tabSize);
                        const isExternal = this.bufferManager.isExternalTextDocument(editor.document);
                        const update = this.highlightProvider.processHLCellsEvent(
                            grid,
                            row,
                            finalStartCol,
                            isExternal,
                            cells,
                            line,
                        );
                        if (update) {
                            gridHLUpdates.add(grid);
                        }
                    }
                    break;
                }
            }
        }
        if (gridHLUpdates.size) {
            this.applyHLGridUpdates(gridHLUpdates);
        }
    }

    public async handleExtensionRequest(name: string, args: unknown[]): Promise<void> {
        switch (name) {
            case "text-decorations": {
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                const [hlName, cols] = args as any;
                this.applyTextDecorations(hlName, cols);
                break;
            }
        }
    }

    private get lastViewportRow(): number {
        return this.settings.viewportHeight - 1;
    }

    private applyHLGridUpdates = (updates: Set<number>): void => {
        for (const grid of updates) {
            const gridConf = this.gridLineInfo.get(grid);
            const editor = this.bufferManager.getEditorFromGridId(grid);
            if (!editor || !gridConf) {
                continue;
            }
            const hls = this.highlightProvider.getGridHighlights(grid, gridConf.topLine);
            for (const [decorator, ranges] of hls) {
                editor.setDecorations(decorator, ranges);
            }
        }
    };

    /**
     * Apply text decorations from external command. Currently used by easymotion fork
     * @param hlGroupName VIM HL Group name
     * @param decorations Text decorations, the format is [[lineNum, [colNum, text][]]]
     */
    private applyTextDecorations(hlGroupName: string, decorations: [string, [number, string][]][]): void {
        const editor = window.activeTextEditor;
        if (!editor) {
            return;
        }
        const decorator = this.highlightProvider.getDecoratorForHighlightGroup(hlGroupName);
        if (!decorator) {
            return;
        }
        const conf = this.highlightProvider.getDecoratorOptions(decorator);
        const options: DecorationOptions[] = [];
        for (const [lineStr, cols] of decorations) {
            try {
                const lineNum = parseInt(lineStr, 10) - 1;
                const line = editor.document.lineAt(lineNum).text;

                for (const [colNum, text] of cols) {
                    // vim sends column in bytes, need to convert to characters
                    // const col = colNum - 1;
                    const col = convertByteNumToCharNum(line, colNum - 1);
                    const opt: DecorationOptions = {
                        range: new Range(lineNum, col, lineNum, col),
                        renderOptions: {
                            before: {
                                ...conf,
                                ...conf.before,
                                contentText: text,
                            },
                        },
                    };
                    options.push(opt);
                }
            } catch {
                // ignore
            }
        }
        editor.setDecorations(decorator, options);
    }

    // TODO: Investigate why it doesn't work. You don't often to change indentation so seems minor
    // private resetHighlight = async (cmd: string): Promise<void> => {
    //     this.logger.debug(`${LOG_PREFIX}: Command wrapper: ${cmd}`);
    //     this.commandsDisposables.forEach((d) => d.dispose());
    //     await commands.executeCommand(cmd);
    //     this.commandsDisposables.push(
    //         commands.registerCommand("editor.action.indentationToTabs", () =>
    //             this.resetHighlight("editor.action.indentationToTabs"),
    //         ),
    //     );
    //     this.commandsDisposables.push(
    //         commands.registerCommand("editor.action.indentationToSpaces", () =>
    //             this.resetHighlight("editor.action.indentationToSpaces"),
    //         ),
    //     );
    //     this.commandsDisposables.push(
    //         commands.registerCommand("editor.action.reindentlines", () =>
    //             this.resetHighlight("editor.action.reindentlines"),
    //         ),
    //     );
    //     // Try clear highlights and force redraw
    //     for (const editor of window.visibleTextEditors) {
    //         const grid = this.bufferManager.getGridIdFromEditor(editor);
    //         if (!grid) {
    //             continue;
    //         }
    //         this.logger.debug(`${LOG_PREFIX}: Clearing HL ranges for grid: ${grid}`);
    //         const reset = this.highlightProvider.clearHighlights(grid);
    //         for (const [decorator, range] of reset) {
    //             editor.setDecorations(decorator, range);
    //         }
    //     }
    //     this.logger.debug(`${LOG_PREFIX}: Redrawing`);
    //     this.client.command("redraw!");
    // };
}
