/**
 * The three dialogs an extension can open over the editor: a selector, a single-line input, and a
 * multi-line editor. Each takes over the editor container while it is open and puts the editor
 * back when it closes, so they share one show/hide shape here instead of each carrying its own
 * copy of the container wiring.
 *
 * Extracted from `InteractiveMode`. The host surface is deliberately narrow — the container the
 * dialogs render into, the editor they restore, and the hook that drops the main selector before a
 * dialog mounts — so this module owns its own components and nothing else.
 */

import type { Container, EditorComponent, TUI } from "@earendil-works/pi-tui";
import type { ExtensionUIDialogOptions } from "../../core/extensions/index.ts";
import type { KeybindingsManager } from "../../core/keybindings.ts";
import { ExtensionEditorComponent } from "./components/extension-editor.ts";
import { ExtensionInputComponent } from "./components/extension-input.ts";
import { ExtensionSelectorComponent } from "./components/extension-selector.ts";

export interface ExtensionDialogsHost {
	readonly ui: TUI;
	readonly editor: EditorComponent;
	readonly editorContainer: Container;
	readonly keybindings: KeybindingsManager;
	getExternalEditorCommand(): string;
	/** Drop whatever the main selector is showing, if anything, before a dialog takes the container. */
	disposeActiveSelector(): void;
	toggleToolOutputExpansion(): void;
}

export class ExtensionDialogs {
	private readonly host: ExtensionDialogsHost;
	private selector: ExtensionSelectorComponent | undefined;
	private input: ExtensionInputComponent | undefined;
	private editor: ExtensionEditorComponent | undefined;

	constructor(host: ExtensionDialogsHost) {
		this.host = host;
	}

	/** Show a selector for extensions. */
	showSelector(title: string, options: string[], opts?: ExtensionUIDialogOptions): Promise<string | undefined> {
		return new Promise((resolve) => {
			if (opts?.signal?.aborted) {
				resolve(undefined);
				return;
			}

			const onAbort = () => {
				this.hideSelector();
				resolve(undefined);
			};
			opts?.signal?.addEventListener("abort", onAbort, { once: true });

			this.selector = new ExtensionSelectorComponent(
				title,
				options,
				(option) => {
					opts?.signal?.removeEventListener("abort", onAbort);
					this.hideSelector();
					resolve(option);
				},
				() => {
					opts?.signal?.removeEventListener("abort", onAbort);
					this.hideSelector();
					resolve(undefined);
				},
				{
					tui: this.host.ui,
					timeout: opts?.timeout,
					onToggleToolsExpanded: () => this.host.toggleToolOutputExpansion(),
				},
			);

			this.host.disposeActiveSelector();
			this.host.editorContainer.clear();
			this.host.editorContainer.addChild(this.selector);
			this.host.ui.setFocus(this.selector);
			this.host.ui.requestRender();
		});
	}

	/** Hide the extension selector. */
	hideSelector(): void {
		this.selector?.dispose();
		this.host.editorContainer.clear();
		this.host.editorContainer.addChild(this.host.editor);
		this.selector = undefined;
		this.host.ui.setFocus(this.host.editor);
		this.host.ui.requestRender();
	}

	/** Show a confirmation dialog for extensions. */
	async confirm(title: string, message: string, opts?: ExtensionUIDialogOptions): Promise<boolean> {
		const result = await this.showSelector(`${title}\n${message}`, ["Yes", "No"], opts);
		return result === "Yes";
	}

	/** Show a text input for extensions. */
	showInput(title: string, placeholder?: string, opts?: ExtensionUIDialogOptions): Promise<string | undefined> {
		return new Promise((resolve) => {
			if (opts?.signal?.aborted) {
				resolve(undefined);
				return;
			}

			const onAbort = () => {
				this.hideInput();
				resolve(undefined);
			};
			opts?.signal?.addEventListener("abort", onAbort, { once: true });

			this.input = new ExtensionInputComponent(
				title,
				placeholder,
				(value) => {
					opts?.signal?.removeEventListener("abort", onAbort);
					this.hideInput();
					resolve(value);
				},
				() => {
					opts?.signal?.removeEventListener("abort", onAbort);
					this.hideInput();
					resolve(undefined);
				},
				{ tui: this.host.ui, timeout: opts?.timeout },
			);

			this.host.disposeActiveSelector();
			this.host.editorContainer.clear();
			this.host.editorContainer.addChild(this.input);
			this.host.ui.setFocus(this.input);
			this.host.ui.requestRender();
		});
	}

	/** Hide the extension input. */
	hideInput(): void {
		this.input?.dispose();
		this.host.editorContainer.clear();
		this.host.editorContainer.addChild(this.host.editor);
		this.input = undefined;
		this.host.ui.setFocus(this.host.editor);
		this.host.ui.requestRender();
	}

	/** Show a multi-line editor for extensions (with Ctrl+G support). */
	showEditor(title: string, prefill?: string): Promise<string | undefined> {
		return new Promise((resolve) => {
			this.editor = new ExtensionEditorComponent(
				this.host.ui,
				this.host.keybindings,
				title,
				prefill,
				(value) => {
					this.hideEditor();
					resolve(value);
				},
				() => {
					this.hideEditor();
					resolve(undefined);
				},
				undefined,
				this.host.getExternalEditorCommand(),
			);

			this.host.disposeActiveSelector();
			this.host.editorContainer.clear();
			this.host.editorContainer.addChild(this.editor);
			this.host.ui.setFocus(this.editor);
			this.host.ui.requestRender();
		});
	}

	/** Hide the extension editor. */
	hideEditor(): void {
		this.host.editorContainer.clear();
		this.host.editorContainer.addChild(this.host.editor);
		this.editor = undefined;
		this.host.ui.setFocus(this.host.editor);
		this.host.ui.requestRender();
	}

	/**
	 * Close every open dialog. Called when the session is reloaded: the components belong to the
	 * session that opened them, so they are dropped rather than carried across.
	 */
	reset(): void {
		if (this.selector) {
			this.hideSelector();
		}
		if (this.input) {
			this.hideInput();
		}
		if (this.editor) {
			this.hideEditor();
		}
	}
}
