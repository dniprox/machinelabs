import { Component, OnInit, ViewChild } from '@angular/core';
import { Location } from '@angular/common';
import { Router, ActivatedRoute } from '@angular/router';
import { MdDialog, MdDialogRef, MdSnackBar, MdTabGroup, MdSidenav } from '@angular/material';
import { AceEditorComponent } from '../ace-editor/ace-editor.component';
import { FileNameDialogComponent } from '../file-name-dialog/file-name-dialog.component';
import { EditLabDialogComponent } from '../edit-lab-dialog/edit-lab-dialog.component';
import {
  NavigationConfirmDialogComponent,
  NavigationConfirmReason
} from '../navigation-confirm-dialog/navigation-confirm-dialog.component';
import { RejectionDialogComponent } from '../rejection-dialog/rejection-dialog.component';
import { RemoteLabExecService } from '../remote-code-execution/remote-lab-exec.service';
import { EditorSnackbarService } from '../editor-snackbar.service';
import { LabStorageService } from '../../lab-storage.service';
import { BLANK_LAB_TPL_ID } from '../../lab-template.service';
import { Observable } from 'rxjs/Observable';
import { Subscription } from 'rxjs/Subscription';
import { Lab, File } from '../../models/lab';
import { Directory } from '../../util/directory';
import { LabExecutionService } from '../../lab-execution.service';
import { SlimLoadingBarService } from 'ng2-slim-loading-bar';
import { LocationHelper } from '../../util/location-helper';
import {
  Execution,
  ExecutionMessage,
  MessageKind,
  ExecutionRejectionInfo,
  ExecutionRejectionReason,
  ExecutionWrapper
} from '../../models/execution';
import { EditorToolbarAction, EditorToolbarActionTypes } from '../editor-toolbar/editor-toolbar.component';

import 'rxjs/add/observable/of';
import 'rxjs/add/observable/timer';
import 'rxjs/add/operator/do';
import 'rxjs/add/operator/filter';
import 'rxjs/add/operator/map';
import 'rxjs/add/operator/scan';
import 'rxjs/add/operator/skip';
import 'rxjs/add/operator/switchMap';
import 'rxjs/add/operator/take';
import 'rxjs/add/operator/takeUntil';
import 'rxjs/add/operator/share';

enum TabIndex {
  Editor,
  Console,
  Settings
}

interface EditLabDialogOptions {
  hideCancelButton: boolean;
}

const METADATA_SIDEBAR_OPEN_TIMEOUT = 600;
const EXECUTION_START_TIMEOUT = 5000;
const INITIAL_LOADING_INDICATOR_PROGRESS = 10;

@Component({
  selector: 'ml-editor-view',
  templateUrl: './editor-view.component.html',
  styleUrls: ['./editor-view.component.scss']
})
export class EditorViewComponent implements OnInit {

  output: Observable<string>;

  lab: Lab;

  latestLab: Lab;

  execution: Observable<Execution>;

  executionSubscription: Subscription;

  executions: Observable<Array<Observable<Execution>>>;

  showRestoreMessage = false;

  sidebarToggled = false;

  activeFile: File;

  fileNameDialogRef: MdDialogRef<FileNameDialogComponent>;

  navigationConfirmDialogRef: MdDialogRef<NavigationConfirmDialogComponent>;

  @ViewChild(MdTabGroup) tabGroup: MdTabGroup;

  @ViewChild('executionMetadataSidebar') executionMetadataSidebar: MdSidenav;

  @ViewChild('outputPanel') outputPanel: AceEditorComponent;

  @ViewChild('editor') editor: AceEditorComponent;

  editLabDialogRef: MdDialogRef<EditLabDialogComponent>;

  rejectionDialogRef: MdDialogRef<RejectionDialogComponent>;

  selectedTab = TabIndex.Editor;

  TabIndex = TabIndex;

  activeExecutionId: string;

  constructor (private rleService: RemoteLabExecService,
               private labStorageService: LabStorageService,
               private route: ActivatedRoute,
               private dialog: MdDialog,
               private editorSnackbar: EditorSnackbarService,
               private location: Location,
               private locationHelper: LocationHelper,
               private router: Router,
               private slimLoadingBarService: SlimLoadingBarService,
               private labExecutionService: LabExecutionService) {
  }

  ngOnInit () {
    this.activeExecutionId = this.route.snapshot.paramMap.get('executionId');
    this.route.data.map(data => data['lab'])
              // Only init lab when it's opened for the first time
              // or when switching labs.
              .filter(lab => !!!this.lab || lab.id !== this.lab.id)
              .subscribe(lab => this.initLab(lab));

    if (this.activeExecutionId) {
      this.listen(this.activeExecutionId);
    }
  }

  toolbarAction(action: EditorToolbarAction) {
    switch (action.type) {
      case EditorToolbarActionTypes.Run: this.run(action.data); break;
      case EditorToolbarActionTypes.Edit: this.edit(action.data); break;
      case EditorToolbarActionTypes.Save: this.save(action.data); break;
      case EditorToolbarActionTypes.Fork: this.fork(action.data); break;
      case EditorToolbarActionTypes.Create: this.create(); break;
    }
  }

  selectTab(tabIndex: TabIndex) {
    this.selectedTab = tabIndex;
    if (this.selectedTab === TabIndex.Editor && this.editor) {
      // This has to run in the next tick after the editor has become visible
      // https://github.com/ajaxorg/ace/issues/3070
      setTimeout(_ => this.editor.resize(), 0);
    } else if (this.selectedTab === TabIndex.Console && this.outputPanel) {
      setTimeout(_ => this.outputPanel.resize(), 0);
    }
  }

  run(lab: Lab) {
    this.outputPanel.clear();
    this.selectTab(TabIndex.Console);
    this.latestLab = Object.assign({}, lab);
    // First check if this lab is already persisted or not. We don't want to
    // execute labs that don't exist in the database.
    this.labStorageService.labExists(lab.id)
        // If it doesn't exist yet, we save it first and make sure to update
        // the url accordingly, so it can be easily shared.
        .switchMap(exists => exists ? Observable.of(null) : this.labStorageService.saveLab(lab))
        .subscribe(_ => {

          const runInfo$ = this.rleService.run(lab).share();

          runInfo$.subscribe(info => {
            if (info.persistent) {
              this.locationHelper.updateUrl(['/editor', lab.id, info.executionId], {
                queryParamsHandling: 'merge'
              });
              this.activeExecutionId = info.executionId;
              this.listen(this.activeExecutionId);
            } else if (info.rejection) {
              if (info.rejection.reason === ExecutionRejectionReason.InvalidConfig) {
                this.editorSnackbar.notifyInvalidConfig();
              } else {
                this.openRejectionDialog(info.rejection.reason);
              }
            }
          });

          this.editorSnackbar.notifyLateExecutionUnless(runInfo$.skip(1));
        });
  }

  consume(wrapper: ExecutionWrapper) {
    this.slimLoadingBarService.progress = INITIAL_LOADING_INDICATOR_PROGRESS;
    this.outputPanel.clear();
    this.execution = wrapper.execution;

    if (this.executionSubscription) {
      this.executionSubscription.unsubscribe();
    }

    // The take(1) may make it seem as if we don't have to care about unsubscribing
    // but think about an Execution coming in late when the user actually has already
    // opened up a different execution. It would cause our lab contents to get overwritten
    // with the wrong files.
    this.executionSubscription = this.execution
      .take(1)
      .subscribe(execution => {
        this.slimLoadingBarService.complete();
        this.showRestoreMessage = Directory.isSameDirectory(execution.lab.directory, this.latestLab.directory);
        this.initDirectory(execution.lab.directory);
      });

    let messages$ = wrapper.messages;

    // Scan the notifications and build up a string with line breaks
    // Don't make this a manual subscription without dealing with
    // Unsubscribing. The returned Observable may not auto complete
    // in all scenarios.
    this.output = messages$
                    .do(msg => {
                      if (msg.kind === MessageKind.ExecutionFinished) {
                        this.editorSnackbar.notifyExecutionFinished();
                      }
                    })
                    .filter(msg => msg.kind === MessageKind.ExecutionStarted ||
                        msg.kind === MessageKind.Stdout || msg.kind === MessageKind.Stderr)
                    .scan((acc, current) => `${acc}\n${current.data}`, '');


    this.editorSnackbar.notifyLateExecutionUnless(messages$);
    this.openExecutionList();
  }

  listenAndUpdateUrl(execution: Execution) {
    this.locationHelper.updateUrl(['/editor', execution.lab.id, execution.id], {
      queryParamsHandling: 'merge'
    });
    this.activeExecutionId = execution.id;
    this.listen(this.activeExecutionId);
  }

  listen(executionId: string) {
    this.consume(this.rleService.listen(executionId));
  }

  fork(lab: Lab) {
    this.labStorageService.createLab(lab).subscribe(createdLab => {
      this.lab = createdLab;
      this.showEditDialog(createdLab, {
        hideCancelButton: true
      }).subscribe(info => {
        this.outputPanel.clear();
        this.activeExecutionId = null;
        this.showRestoreMessage = false;
        // we allways need to save after forking but either the
        // version from before the dialog or the one after
        this.save(info.shouldSave ? info.lab : createdLab, 'Lab forked', true);
      });
    });
  }

  edit(lab: Lab) {
    this.showEditDialog(lab)
        .subscribe(info => {
          if (info.shouldSave) {
            this.save(info.lab);
          }
        });
  }

  save(lab: Lab, msg = 'Lab saved', fetchExecutions = false) {
    this.labStorageService.saveLab(lab).subscribe(() => {
      this.initLab(lab, fetchExecutions);

      const urlSegments = ['/editor', lab.id];

      if (this.activeExecutionId) {
        urlSegments.push(this.activeExecutionId);
      }

      this.locationHelper.updateUrl(urlSegments, {
        queryParamsHandling: 'preserve'
      });
      this.editorSnackbar.notify(msg);
    });
  }

  showEditDialog(lab: Lab, options: EditLabDialogOptions = {
    hideCancelButton: false
  }) {
    this.editLabDialogRef = this.dialog.open(EditLabDialogComponent, {
          disableClose: false,
          data: {
            lab: lab,
            options
          }
        });

    return this.editLabDialogRef
            .afterClosed()
            // if it doesn't have an info it was closed by ESC
            // TODO: any way to handle this from inside the EditDialog?
            .map(info => info || { shouldSave: false, lab: null })
            .do(info => {
              if (info.shouldSave) {
                this.lab = info.lab;
              }
            });
  }

  create() {
    this.navigationConfirmDialogRef = this.dialog.open(NavigationConfirmDialogComponent, {
      disableClose: false,
      data: {
        reason: NavigationConfirmReason.UnsavedChanges
      }
    });

    this.navigationConfirmDialogRef.afterClosed()
      .filter(confirmed => confirmed)
      .switchMap(_ => this.labStorageService.createLab())
      .subscribe(lab => {
        this.outputPanel.clear();
        this.goToLab();
        this.initLab(lab);
        this.editorSnackbar.notifyLabCreated();
      });
  }

  log(value) {
    console.log(value);
  }

  openFile(file: File) {
    this.activeFile = file;
    this.locationHelper.updateQueryParams(this.location.path(), {
      file: file.name,
    });
  }

  deleteFile(file: File) {
    this.lab.directory.splice(this.lab.directory.indexOf(file), 1);
    this.openFile(this.lab.directory[0]);
  }

  updateFile(file: File, newFile: File) {
    const index = this.lab.directory.findIndex(f => f.name === file.name);
    if (index !== -1) {
      this.lab.directory[index] = newFile;
    }
  }

  openFileNameDialog(file?: File) {
    this.fileNameDialogRef = this.dialog.open(FileNameDialogComponent, {
      disableClose: false,
      data: {
        fileName: file ? file.name :  ''
      }
    });

    this.fileNameDialogRef.afterClosed()
      .filter(name => name !== '' && name !== undefined)
      .subscribe(name => {
        if (!file) {
          const newFile = { name, content: '' };
          this.lab.directory.push(newFile);
          this.openFile(newFile);
        } else {
          this.updateFile(file, { name, content: file.content});
        }
      });
  }

  openRejectionDialog(rejectionReason: ExecutionRejectionReason) {
    this.rejectionDialogRef = this.dialog.open(RejectionDialogComponent, {
      data: { rejectionReason }
    });
  }

  initLab(lab: Lab, fetchExecutions = true) {
    this.lab = lab;
    this.latestLab = Object.assign({}, this.lab);
    this.selectTab(TabIndex.Editor);
    this.initDirectory(lab.directory);
    if (fetchExecutions) {
      this.initExecutionList();
    }
  }

  private initExecutionList() {
    this.executions = this.labExecutionService.observeExecutionsForLab(this.lab).share();
    this.executions
        .take(1)
        .map(executions => executions.length > 0 ? executions[0] : null)
        .filter(obsExecution => !!obsExecution)
        .do(_ => this.openExecutionList())
        .subscribe(_ => {
          if (this.activeExecutionId) {
            this.selectTab(TabIndex.Console);
          }
        });
  }

  restoreLab() {
    this.selectTab(TabIndex.Editor);
    this.outputPanel.clear();
    this.activeExecutionId = null;
    this.locationHelper.updateUrl(['/editor', this.lab.id], {
      queryParamsHandling: 'merge'
    });
    this.initDirectory(this.latestLab.directory);
    this.showRestoreMessage = false;

    setTimeout(() => {
      this.executionMetadataSidebar.close();
      this.editorSnackbar.notifyLabRestored();
    }, METADATA_SIDEBAR_OPEN_TIMEOUT);
  }

  private initDirectory(directory: Array<File>) {
    this.lab.directory = directory;
    // try query param file name first
    const file = this.lab.directory.find(f => f.name === this.router.parseUrl(this.location.path(false)).queryParams.file);
    this.openFile(file || this.lab.directory[0]);
  }

  private goToLab(lab?: Lab, queryParams?) {
    this.locationHelper.updateUrl(['/editor', `${lab ? lab.id : ''}`], {
      queryParamsHandling: 'merge',
      queryParams: queryParams || {}
    });
  }

  private openExecutionList() {
    setTimeout(() => {
      this.executionMetadataSidebar.open();
    }, METADATA_SIDEBAR_OPEN_TIMEOUT);
  }
}