import type { ProjectEnvelope, JsonValue } from '../parallel/contracts';
import type { Scene } from '../scene';
import { canonical, sha256, utf8 } from './canonical';
export interface Versions { engine: string; ui: string; corpus: string }
export interface Attachment { id: string; name: string; type: string; bytes: Uint8Array; metadata: Record<string, JsonValue> }
export interface JournalEntry { at: string; who: string; action: string; before: ProjectEnvelope; after: ProjectEnvelope }
export interface ProjectFile {
  project: ProjectEnvelope; versions: Versions; attachments: Attachment[];
  journal: JournalEntry[]; savedResults?: JsonValue; resultInputHash?: string;
}
export const UI_VERSION = '0.2.0';
export function envelope(scene: Scene): ProjectEnvelope {
  return {contractVersion:1, scene:structuredClone(scene), extensions:{physics:{},rules:{},workspace:{}}, evidence:[]};
}
export function newProject(scene: Scene): ProjectFile {
  return {project:envelope(scene), versions:{engine:'unavailable',ui:UI_VERSION,corpus:'unrecorded'},attachments:[],journal:[]};
}
export const inputHash = (project: ProjectEnvelope): Promise<string> => sha256(utf8(canonical(project)));
export class ProjectHistory {
  private undoStates: ProjectEnvelope[] = [];
  private redoStates: ProjectEnvelope[] = [];
  constructor(public file: ProjectFile, public who = 'Локальный пользователь') {}
  change(next: ProjectEnvelope, action: string, at = new Date().toISOString()): boolean {
    if (canonical(this.file.project) === canonical(next)) return false;
    this.undoStates.push(structuredClone(this.file.project)); this.redoStates=[];
    this.record(next, action, at); return true;
  }
  private record(next: ProjectEnvelope, action: string, at: string): void {
    this.file.journal.push({at,who:this.who,action,before:structuredClone(this.file.project),after:structuredClone(next)});
    this.file.project=structuredClone(next);
    delete this.file.savedResults; delete this.file.resultInputHash;
  }
  undo(): void { const next=this.undoStates.pop(); if(next){this.redoStates.push(structuredClone(this.file.project));this.record(next,'undo',new Date().toISOString());} }
  redo(): void { const next=this.redoStates.pop(); if(next){this.undoStates.push(structuredClone(this.file.project));this.record(next,'redo',new Date().toISOString());} }
  restore(index:number):void { const entry=this.file.journal[index]; if(!entry)throw new Error('Нет версии'); this.change(entry.after,`restore:${index}`); }
}
