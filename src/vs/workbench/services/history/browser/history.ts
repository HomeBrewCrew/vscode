/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

'use strict';

import { TPromise } from 'vs/base/common/winjs.base';
import errors = require('vs/base/common/errors');
import URI from 'vs/base/common/uri';
import { IEditor } from 'vs/editor/common/editorCommon';
import { IEditor as IBaseEditor, IEditorInput, ITextEditorOptions, IResourceInput, ITextEditorSelection, Position as GroupPosition } from 'vs/platform/editor/common/editor';
import { EditorInput, IEditorCloseEvent, IEditorRegistry, Extensions, toResource, IEditorGroup } from 'vs/workbench/common/editor';
import { IWorkbenchEditorService } from 'vs/workbench/services/editor/common/editorService';
import { IHistoryService } from 'vs/workbench/services/history/common/history';
import { FileChangesEvent, IFileService, FileChangeType } from 'vs/platform/files/common/files';
import { Selection } from 'vs/editor/common/core/selection';
import { IWorkspaceContextService } from 'vs/platform/workspace/common/workspace';
import { IDisposable, dispose } from 'vs/base/common/lifecycle';
import { IStorageService, StorageScope } from 'vs/platform/storage/common/storage';
import { ILifecycleService } from 'vs/platform/lifecycle/common/lifecycle';
import { Registry } from 'vs/platform/registry/common/platform';
import { once } from 'vs/base/common/event';
import { IConfigurationService } from 'vs/platform/configuration/common/configuration';
import { IEditorGroupService } from 'vs/workbench/services/group/common/groupService';
import { IWindowsService } from 'vs/platform/windows/common/windows';
import { getCodeEditor } from 'vs/editor/common/services/codeEditorService';
import { getExcludes, ISearchConfiguration } from 'vs/platform/search/common/search';
import { parse, IExpression } from 'vs/base/common/glob';
import { ICursorPositionChangedEvent } from 'vs/editor/common/controller/cursorEvents';
import { IInstantiationService } from 'vs/platform/instantiation/common/instantiation';
import { ResourceGlobMatcher } from 'vs/workbench/common/resources';

/**
 * Stores the selection & view state of an editor and allows to compare it to other selection states.
 */
export class TextEditorState {

	private static EDITOR_SELECTION_THRESHOLD = 10; // number of lines to move in editor to justify for new state

	private textEditorSelection: ITextEditorSelection;

	constructor(private _editorInput: IEditorInput, private _selection: Selection) {
		this.textEditorSelection = Selection.isISelection(_selection) ? {
			startLineNumber: _selection.startLineNumber,
			startColumn: _selection.startColumn
		} : void 0;
	}

	public get editorInput(): IEditorInput {
		return this._editorInput;
	}

	public get selection(): ITextEditorSelection {
		return this.textEditorSelection;
	}

	public justifiesNewPushState(other: TextEditorState, event?: ICursorPositionChangedEvent): boolean {
		if (event && event.source === 'api') {
			return true; // always let API source win (e.g. "Go to definition" should add a history entry)
		}

		if (!this._editorInput.matches(other._editorInput)) {
			return true; // different editor inputs
		}

		if (!Selection.isISelection(this._selection) || !Selection.isISelection(other._selection)) {
			return true; // unknown selections
		}

		const thisLineNumber = Math.min(this._selection.selectionStartLineNumber, this._selection.positionLineNumber);
		const otherLineNumber = Math.min(other._selection.selectionStartLineNumber, other._selection.positionLineNumber);

		if (Math.abs(thisLineNumber - otherLineNumber) < TextEditorState.EDITOR_SELECTION_THRESHOLD) {
			return false; // ignore selection changes in the range of EditorState.EDITOR_SELECTION_THRESHOLD lines
		}

		return true;
	}
}

interface ISerializedFileHistoryEntry {
	resource?: string;
	resourceJSON: object;
}

interface IEditorIdentifier {
	editor: IEditorInput;
	position: GroupPosition;
}

export abstract class BaseHistoryService {

	protected toUnbind: IDisposable[];

	private activeEditorListeners: IDisposable[];
	private lastActiveEditor: IEditorIdentifier;

	constructor(
		protected editorGroupService: IEditorGroupService,
		protected editorService: IWorkbenchEditorService
	) {
		this.toUnbind = [];
		this.activeEditorListeners = [];

		// Listeners
		this.toUnbind.push(this.editorGroupService.onEditorsChanged(() => this.onEditorsChanged()));
	}

	private onEditorsChanged(): void {
		const activeEditor = this.editorService.getActiveEditor();
		if (this.lastActiveEditor && this.matchesEditor(this.lastActiveEditor, activeEditor)) {
			return; // return if the active editor is still the same
		}

		// Remember as last active editor (can be undefined if none opened)
		this.lastActiveEditor = activeEditor ? { editor: activeEditor.input, position: activeEditor.position } : void 0;

		// Dispose old listeners
		dispose(this.activeEditorListeners);
		this.activeEditorListeners = [];

		// Propagate to history
		this.handleActiveEditorChange(activeEditor);

		// Apply listener for selection changes if this is a text editor
		const control = getCodeEditor(activeEditor);
		if (control) {
			this.activeEditorListeners.push(control.onDidChangeCursorPosition(event => {
				this.handleEditorSelectionChangeEvent(activeEditor, event);
			}));
		}
	}

	private matchesEditor(identifier: IEditorIdentifier, editor?: IBaseEditor): boolean {
		if (!editor) {
			return false;
		}

		if (identifier.position !== editor.position) {
			return false;
		}

		return identifier.editor.matches(editor.input);
	}

	protected abstract handleExcludesChange(): void;

	protected abstract handleEditorSelectionChangeEvent(editor?: IBaseEditor, event?: ICursorPositionChangedEvent): void;

	protected abstract handleActiveEditorChange(editor?: IBaseEditor): void;

	public dispose(): void {
		this.toUnbind = dispose(this.toUnbind);
	}
}

interface IStackEntry {
	input: IEditorInput | IResourceInput;
	selection?: ITextEditorSelection;
	timestamp: number;
}

interface IRecentlyClosedFile {
	resource: URI;
	index: number;
}

export class HistoryService extends BaseHistoryService implements IHistoryService {

	public _serviceBrand: any;

	private static STORAGE_KEY = 'history.entries';
	private static MAX_HISTORY_ITEMS = 200;
	private static MAX_STACK_ITEMS = 20;
	private static MAX_RECENTLY_CLOSED_EDITORS = 20;
	private static MERGE_EVENT_CHANGES_THRESHOLD = 300;

	private stack: IStackEntry[];
	private index: number;
	private lastIndex: number;
	private navigatingInStack: boolean;
	private currentTextEditorState: TextEditorState;

	private history: (IEditorInput | IResourceInput)[];
	private recentlyClosedFiles: IRecentlyClosedFile[];
	private loaded: boolean;
	private registry: IEditorRegistry;
	private resourceFilter: ResourceGlobMatcher;

	constructor(
		@IWorkbenchEditorService editorService: IWorkbenchEditorService,
		@IEditorGroupService editorGroupService: IEditorGroupService,
		@IWorkspaceContextService private contextService: IWorkspaceContextService,
		@IStorageService private storageService: IStorageService,
		@IConfigurationService private configurationService: IConfigurationService,
		@ILifecycleService private lifecycleService: ILifecycleService,
		@IFileService private fileService: IFileService,
		@IWindowsService private windowService: IWindowsService,
		@IInstantiationService private instantiationService: IInstantiationService,
	) {
		super(editorGroupService, editorService);

		this.index = -1;
		this.lastIndex = -1;
		this.stack = [];
		this.recentlyClosedFiles = [];
		this.loaded = false;
		this.registry = Registry.as<IEditorRegistry>(Extensions.Editors);
		this.resourceFilter = instantiationService.createInstance(ResourceGlobMatcher, (root: URI) => this.getExcludes(root), (expression: IExpression) => parse(expression));

		this.registerListeners();
	}

	private setIndex(value: number): void {
		this.lastIndex = this.index;
		this.index = value;
	}

	private getExcludes(root?: URI): IExpression {
		const scope = root ? { resource: root } : void 0;

		return getExcludes(this.configurationService.getConfiguration<ISearchConfiguration>(void 0, scope));
	}

	private registerListeners(): void {
		this.toUnbind.push(this.lifecycleService.onShutdown(reason => this.save()));
		this.toUnbind.push(this.editorGroupService.onEditorOpenFail(editor => this.remove(editor)));
		this.toUnbind.push(this.editorGroupService.getStacksModel().onEditorClosed(event => this.onEditorClosed(event)));
		this.toUnbind.push(this.fileService.onFileChanges(e => this.onFileChanges(e)));
		this.toUnbind.push(this.resourceFilter.onExpressionChange(() => this.handleExcludesChange()));
	}

	private onFileChanges(e: FileChangesEvent): void {
		if (e.gotDeleted()) {
			this.remove(e); // remove from history files that got deleted or moved
		}
	}

	private onEditorClosed(event: IEditorCloseEvent): void {

		// Track closing of pinned editor to support to reopen closed editors
		if (event.pinned) {
			const file = toResource(event.editor, { filter: 'file' }); // we only support files to reopen
			if (file) {

				// Remove all inputs matching and add as last recently closed
				this.removeFromRecentlyClosedFiles(event.editor);
				this.recentlyClosedFiles.push({ resource: file, index: event.index });

				// Bounding
				if (this.recentlyClosedFiles.length > HistoryService.MAX_RECENTLY_CLOSED_EDITORS) {
					this.recentlyClosedFiles.shift();
				}
			}
		}
	}

	public reopenLastClosedEditor(): void {
		this.ensureHistoryLoaded();

		const stacks = this.editorGroupService.getStacksModel();

		let lastClosedFile = this.recentlyClosedFiles.pop();
		while (lastClosedFile && this.isFileOpened(lastClosedFile.resource, stacks.activeGroup)) {
			lastClosedFile = this.recentlyClosedFiles.pop(); // pop until we find a file that is not opened
		}

		if (lastClosedFile) {
			this.editorService.openEditor({ resource: lastClosedFile.resource, options: { pinned: true, index: lastClosedFile.index } });
		}
	}

	public forward(acrossEditors?: boolean): void {
		if (this.stack.length > this.index + 1) {
			if (acrossEditors) {
				this.doForwardAcrossEditors();
			} else {
				this.doForwardInEditors();
			}
		}
	}

	private doForwardInEditors(): void {
		this.setIndex(this.index + 1);
		this.navigate();
	}

	private doForwardAcrossEditors(): void {
		let currentIndex = this.index;
		const currentEntry = this.stack[this.index];

		// Find the next entry that does not match our current entry
		while (this.stack.length > currentIndex + 1) {
			currentIndex++;

			const previousEntry = this.stack[currentIndex];
			if (!this.matches(currentEntry.input, previousEntry.input)) {
				this.setIndex(currentIndex);
				this.navigate(true /* across editors */);

				break;
			}
		}
	}

	public back(acrossEditors?: boolean): void {
		if (this.index > 0) {
			if (acrossEditors) {
				this.doBackAcrossEditors();
			} else {
				this.doBackInEditors();
			}
		}
	}

	public last(): void {
		if (this.lastIndex === -1) {
			this.back();
		} else {
			this.setIndex(this.lastIndex);
			this.navigate();
		}
	}

	private doBackInEditors(): void {
		this.setIndex(this.index - 1);
		this.navigate();
	}

	private doBackAcrossEditors(): void {
		let currentIndex = this.index;
		const currentEntry = this.stack[this.index];

		// Find the next previous entry that does not match our current entry
		while (currentIndex > 0) {
			currentIndex--;

			const previousEntry = this.stack[currentIndex];
			if (!this.matches(currentEntry.input, previousEntry.input)) {
				this.setIndex(currentIndex);
				this.navigate(true /* across editors */);

				break;
			}
		}
	}

	public clear(): void {
		this.ensureHistoryLoaded();

		this.index = -1;
		this.lastIndex = -1;
		this.stack.splice(0);
		this.history = [];
		this.recentlyClosedFiles = [];
	}

	private navigate(acrossEditors?: boolean): void {
		const entry = this.stack[this.index];

		const options: ITextEditorOptions = {
			revealIfOpened: true // support to navigate across editor groups
		};

		// Unless we navigate across editors, support selection and
		// minimize scrolling by setting revealInCenterIfOutsideViewport
		if (entry.selection && !acrossEditors) {
			options.selection = entry.selection;
			options.revealInCenterIfOutsideViewport = true;
		}

		this.navigatingInStack = true;

		let openEditorPromise: TPromise<IBaseEditor>;
		if (entry.input instanceof EditorInput) {
			openEditorPromise = this.editorService.openEditor(entry.input, options);
		} else {
			openEditorPromise = this.editorService.openEditor({ resource: (entry.input as IResourceInput).resource, options });
		}

		openEditorPromise.done(() => {
			this.navigatingInStack = false;
		}, error => {
			this.navigatingInStack = false;
			errors.onUnexpectedError(error);
		});
	}

	protected handleEditorSelectionChangeEvent(editor?: IBaseEditor, event?: ICursorPositionChangedEvent): void {
		this.handleEditorEventInStack(editor, event);
	}

	protected handleActiveEditorChange(editor?: IBaseEditor): void {
		this.handleEditorEventInHistory(editor);
		this.handleEditorEventInStack(editor);
	}

	private handleEditorEventInHistory(editor?: IBaseEditor): void {
		const input = editor ? editor.input : void 0;

		// Ensure we have at least a name to show and not configured to exclude input
		if (!input || !input.getName() || !this.include(input)) {
			return;
		}

		this.ensureHistoryLoaded();

		const historyInput = this.preferResourceInput(input);

		// Remove any existing entry and add to the beginning
		this.removeFromHistory(input);
		this.history.unshift(historyInput);

		// Respect max entries setting
		if (this.history.length > HistoryService.MAX_HISTORY_ITEMS) {
			this.history.pop();
		}

		// Remove this from the history unless the history input is a resource
		// that can easily be restored even when the input gets disposed
		if (historyInput instanceof EditorInput) {
			const onceDispose = once(historyInput.onDispose);
			onceDispose(() => {
				this.removeFromHistory(input);
			});
		}
	}

	private include(input: IEditorInput | IResourceInput): boolean {
		if (input instanceof EditorInput) {
			return true; // include any non files
		}

		const resourceInput = input as IResourceInput;

		return !this.resourceFilter.matches(resourceInput.resource);
	}

	protected handleExcludesChange(): void {
		this.removeExcludedFromHistory();
	}

	public remove(input: IEditorInput | IResourceInput): void;
	public remove(input: FileChangesEvent): void;
	public remove(arg1: IEditorInput | IResourceInput | FileChangesEvent): void {
		this.removeFromHistory(arg1);
		this.removeFromStack(arg1);
		this.removeFromRecentlyClosedFiles(arg1);
		this.removeFromRecentlyOpened(arg1);
	}

	private removeExcludedFromHistory(): void {
		this.ensureHistoryLoaded();

		this.history = this.history.filter(e => this.include(e));
	}

	private removeFromHistory(arg1: IEditorInput | IResourceInput | FileChangesEvent): void {
		this.ensureHistoryLoaded();

		this.history = this.history.filter(e => !this.matches(arg1, e));
	}

	private handleEditorEventInStack(editor: IBaseEditor, event?: ICursorPositionChangedEvent): void {
		const control = getCodeEditor(editor);

		// treat editor changes that happen as part of stack navigation specially
		// we do not want to add a new stack entry as a matter of navigating the
		// stack but we need to keep our currentTextEditorState up to date with
		// the navigtion that occurs.
		if (this.navigatingInStack) {
			if (control && editor.input) {
				this.currentTextEditorState = new TextEditorState(editor.input, control.getSelection());
			} else {
				this.currentTextEditorState = null; // we navigated to a non text editor
			}
		}

		// normal navigation not part of history navigation
		else {

			// navigation inside text editor
			if (control && editor.input) {
				this.handleTextEditorEvent(editor, control, event);
			}

			// navigation to non-text editor
			else {
				this.currentTextEditorState = null; // at this time we have no active text editor view state

				if (editor && editor.input) {
					this.handleNonTextEditorEvent(editor);
				}
			}
		}
	}

	private handleTextEditorEvent(editor: IBaseEditor, editorControl: IEditor, event?: ICursorPositionChangedEvent): void {
		const stateCandidate = new TextEditorState(editor.input, editorControl.getSelection());

		// Add to stack if we dont have a current state or this new state justifies a push
		if (!this.currentTextEditorState || this.currentTextEditorState.justifiesNewPushState(stateCandidate, event)) {
			this.add(editor.input, stateCandidate.selection);
		}

		// Otherwise we replace the current stack entry with this one
		else {
			this.replace(editor.input, stateCandidate.selection);
		}

		// Update our current text editor state
		this.currentTextEditorState = stateCandidate;
	}

	private handleNonTextEditorEvent(editor: IBaseEditor): void {
		const currentStack = this.stack[this.index];
		if (currentStack && this.matches(editor.input, currentStack.input)) {
			return; // do not push same editor input again
		}

		this.add(editor.input);
	}

	public add(input: IEditorInput, selection?: ITextEditorSelection): void {
		if (!this.navigatingInStack) {
			this.addOrReplaceInStack(input, selection);
		}
	}

	private replace(input: IEditorInput, selection?: ITextEditorSelection): void {
		if (!this.navigatingInStack) {
			this.addOrReplaceInStack(input, selection, true /* force replace */);
		}
	}

	private addOrReplaceInStack(input: IEditorInput, selection?: ITextEditorSelection, forceReplace?: boolean): void {

		// Overwrite an entry in the stack if we have a matching input that comes
		// with editor options to indicate that this entry is more specific. Also
		// prevent entries that have the exact same options. Finally, Overwrite
		// entries if we detect that the change came in very fast which indicates
		// that it was not coming in from a user change but rather rapid programmatic
		// changes. We just take the last of the changes to not cause too many entries
		// on the stack.
		// We can also be instructed to force replace the last entry.
		let replace = false;
		if (this.stack[this.index]) {
			if (forceReplace) {
				replace = true;
			} else {
				const currentEntry = this.stack[this.index];
				if (this.matches(input, currentEntry.input) &&													// and: entry of same input
					(
						this.sameSelection(currentEntry.selection, selection) ||								// and: entry has same selection
						(Date.now() - currentEntry.timestamp < HistoryService.MERGE_EVENT_CHANGES_THRESHOLD)	// or: entry occured very fast and is likely not human
					)
				) {
					replace = true;
				}
			}
		}

		const stackInput = this.preferResourceInput(input);
		const entry = { input: stackInput, selection, timestamp: Date.now() };

		// If we are not at the end of history, we remove anything after
		if (this.stack.length > this.index + 1) {
			this.stack = this.stack.slice(0, this.index + 1);
		}

		// Replace at current position
		if (replace) {
			this.stack[this.index] = entry;
		}

		// Add to stack at current position
		else {
			this.setIndex(this.index + 1);
			this.stack.splice(this.index, 0, entry);

			// Check for limit
			if (this.stack.length > HistoryService.MAX_STACK_ITEMS) {
				this.stack.shift(); // remove first and dispose
				if (this.index > 0) {
					this.setIndex(this.index - 1);
				}
			}
		}

		// Remove this from the stack unless the stack input is a resource
		// that can easily be restored even when the input gets disposed
		if (stackInput instanceof EditorInput) {
			const onceDispose = once(stackInput.onDispose);
			onceDispose(() => {
				this.removeFromStack(input);
			});
		}
	}

	private preferResourceInput(input: IEditorInput): IEditorInput | IResourceInput {
		const file = toResource(input, { filter: 'file' });
		if (file) {
			return { resource: file };
		}

		return input;
	}

	private sameSelection(selectionA?: ITextEditorSelection, selectionB?: ITextEditorSelection): boolean {
		if (!selectionA && !selectionB) {
			return true;
		}

		if ((!selectionA && selectionB) || (selectionA && !selectionB)) {
			return false;
		}

		return selectionA.startLineNumber === selectionB.startLineNumber; // we consider the history entry same if we are on the same line
	}

	private removeFromStack(arg1: IEditorInput | IResourceInput | FileChangesEvent): void {
		this.stack = this.stack.filter(e => !this.matches(arg1, e.input));
		this.index = this.stack.length - 1; // reset index
		this.lastIndex = -1;
	}

	private removeFromRecentlyClosedFiles(arg1: IEditorInput | IResourceInput | FileChangesEvent): void {
		this.recentlyClosedFiles = this.recentlyClosedFiles.filter(e => !this.matchesFile(e.resource, arg1));
	}

	private removeFromRecentlyOpened(arg1: IEditorInput | IResourceInput | FileChangesEvent): void {
		if (arg1 instanceof EditorInput || arg1 instanceof FileChangesEvent) {
			return; // for now do not delete from file events since recently open are likely out of workspace files for which there are no delete events
		}

		const input = arg1 as IResourceInput;

		this.windowService.removeFromRecentlyOpened([input.resource.fsPath]);
	}

	private isFileOpened(resource: URI, group: IEditorGroup): boolean {
		if (!group) {
			return false;
		}

		if (!group.contains(resource)) {
			return false; // fast check
		}

		return group.getEditors().some(e => this.matchesFile(resource, e));
	}

	private matches(arg1: IEditorInput | IResourceInput | FileChangesEvent, inputB: IEditorInput | IResourceInput): boolean {
		if (arg1 instanceof FileChangesEvent) {
			if (inputB instanceof EditorInput) {
				return false; // we only support this for IResourceInput
			}

			const resourceInputB = inputB as IResourceInput;

			return arg1.contains(resourceInputB.resource, FileChangeType.DELETED);
		}

		if (arg1 instanceof EditorInput && inputB instanceof EditorInput) {
			return arg1.matches(inputB);
		}

		if (arg1 instanceof EditorInput) {
			return this.matchesFile((inputB as IResourceInput).resource, arg1);
		}

		if (inputB instanceof EditorInput) {
			return this.matchesFile((arg1 as IResourceInput).resource, inputB);
		}

		const resourceInputA = arg1 as IResourceInput;
		const resourceInputB = inputB as IResourceInput;

		return resourceInputA && resourceInputB && resourceInputA.resource.toString() === resourceInputB.resource.toString();
	}

	private matchesFile(resource: URI, arg2: IEditorInput | IResourceInput | FileChangesEvent): boolean {
		if (arg2 instanceof FileChangesEvent) {
			return arg2.contains(resource, FileChangeType.DELETED);
		}

		if (arg2 instanceof EditorInput) {
			const file = toResource(arg2, { filter: 'file' });

			return file && file.toString() === resource.toString();
		}

		const resourceInput = arg2 as IResourceInput;

		return resourceInput && resourceInput.resource.toString() === resource.toString();
	}

	public getHistory(): (IEditorInput | IResourceInput)[] {
		this.ensureHistoryLoaded();

		return this.history.slice(0);
	}

	private ensureHistoryLoaded(): void {
		if (!this.loaded) {
			this.loadHistory();
		}

		this.loaded = true;
	}

	private save(): void {
		if (!this.history) {
			return; // nothing to save because history was not used
		}

		const entries: ISerializedFileHistoryEntry[] = this.history.map(input => {
			if (input instanceof EditorInput) {
				return void 0; // only file resource inputs are serializable currently
			}

			return { resourceJSON: (input as IResourceInput).resource.toJSON() };
		}).filter(serialized => !!serialized);

		this.storageService.store(HistoryService.STORAGE_KEY, JSON.stringify(entries), StorageScope.WORKSPACE);
	}

	private loadHistory(): void {
		let entries: ISerializedFileHistoryEntry[] = [];

		const entriesRaw = this.storageService.get(HistoryService.STORAGE_KEY, StorageScope.WORKSPACE);
		if (entriesRaw) {
			entries = JSON.parse(entriesRaw);
		}

		this.history = entries.map(entry => {
			const serializedFileInput = entry as ISerializedFileHistoryEntry;
			if (serializedFileInput.resource || serializedFileInput.resourceJSON) {
				return { resource: !!serializedFileInput.resourceJSON ? URI.revive(serializedFileInput.resourceJSON) : URI.parse(serializedFileInput.resource) } as IResourceInput;
			}

			return void 0;
		}).filter(input => !!input);
	}

	public getLastActiveWorkspaceRoot(): URI {
		if (!this.contextService.hasWorkspace()) {
			return void 0;
		}

		const history = this.getHistory();
		for (let i = 0; i < history.length; i++) {
			const input = history[i];
			if (input instanceof EditorInput) {
				continue;
			}

			const resourceInput = input as IResourceInput;
			const resourceWorkspace = this.contextService.getRoot(resourceInput.resource);
			if (resourceWorkspace) {
				return resourceWorkspace;
			}
		}

		// fallback to first workspace
		return this.contextService.getWorkspace().roots[0];
	}
}
