import { resolve,relative,isAbsolute } from 'node:path';
import { lstat } from 'node:fs/promises';
import { requireValue,noSymlinks } from '../workflow-paths.mjs';
import { assignedFanoutWritePaths } from './fanout-input-projection.mjs';

export async function fanoutWorkspaces(envelope,items,fanout){
  if(!fanout?.workspace_field)return null;
  const scopes=[];
  for(const item of items){
    const declared=item?.[fanout.workspace_field];
    requireValue(typeof declared==='string'&&declared.trim(),'HOST_MAIN_WORKSPACE_ISOLATION','Every assigned item needs its Host-owned directory');
    const workspace=resolve(envelope.workspace,declared),root=relative(envelope.workspace,workspace).replaceAll('\\','/');
    requireValue(root&&!isAbsolute(root)&&root!=='..'&&!root.startsWith('../'),'HOST_MAIN_WORKSPACE_ISOLATION','Item workspace must be a distinct directory inside the Run workspace');
    await noSymlinks(workspace);requireValue((await lstat(workspace)).isDirectory(),'HOST_MAIN_WORKSPACE_ISOLATION','Item workspace must already exist as a Host-owned directory');
    const allowed=assignedFanoutWritePaths({workspace:envelope.workspace,nodeAllowedPaths:envelope.effective_allowed_paths,assignedItems:[item],fanout});
    const local=allowed.map(path=>{
      requireValue(path===root||path.startsWith(root+'/'),'HOST_MAIN_WORKSPACE_ISOLATION','Every item write grant must stay in its assigned directory');
      return path===root?'.':path.slice(root.length+1);
    });
    const key=value=>process.platform==='win32'?value.toLowerCase():value;
    requireValue(!scopes.some(scope=>key(root)===key(scope.root)||key(root).startsWith(key(scope.root)+'/')||key(scope.root).startsWith(key(root)+'/')),'HOST_MAIN_WORKSPACE_ISOLATION','Item directories cannot overlap accepted siblings');
    scopes.push({workspace,root,allowed_paths:local});
  }
  return scopes;
}
export const parentItemPaths=(scope,paths)=>scope?paths.map(path=>path==='.'?scope.root:scope.root+'/'+path):paths;
