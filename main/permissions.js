export const PRIVACY_PAGES = Object.freeze({microphone:'x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone',input:'x-apple.systempreferences:com.apple.preference.security?Privacy_ListenEvent',accessibility:'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility'});
export const closesOnBlur = ({mode,settingsOpen,setupActive,protectedState=false}) => !protectedState && mode==='centre' && !(mode==='centre' && settingsOpen && setupActive);
// Two rights are enough: the microphone, and Accessibility, which both lets the helper watch fn, Control
// and Option and lets it insert text (as Wispr Flow and Coucou do). Input Monitoring is no longer asked for.
// After both, a short self-test (fn, one sentence) proves the whole chain before setup ends.
export function nextPermission(state) {
  if(state.microphone!=='granted')return 'microphone';
  if(!state.accessibility)return 'accessibility';
  if(state.listening===false || ['unresponsive','missing','checking'].includes(state.helperStatus))return 'listener';
  return state.tested ? 'ready' : 'test';
}
// Polling never requests rights. Native consent can outlive the UI and is never awaited by it.
export class PermissionFlow {
  constructor({readMicrophone,requestMicrophone,keys,openExternal,onChange=()=>{},now=Date.now,actionTimeoutMs=12000}) {
    Object.assign(this,{readMicrophone,requestMicrophone,keys,openExternal,onChange,now,actionTimeoutMs});
    this.values={microphone:'unknown',input:null,accessibility:null,listening:null,missing:false,helperStatus:'checking',requestStatus:'idle',requestKind:null,requestPending:false,lastCheckedAt:null,actionError:null};
    this.timer=null;this.deadline=0;this.inflight=null;this.actionSerial=0;this.actionTimer=null;this.pendingNative=null;this.pendingKind=null;this.pendingByKind=new Map();this.actionPoll=null;this.closed=false;
  }
  state(){return {...this.values,step:nextPermission(this.values),polling:!!this.timer};}
  update(patch){const before=JSON.stringify(this.state());this.values={...this.values,...patch};if(JSON.stringify(this.state())!==before)this.onChange(this.state());}
  passTest(){this.update({tested:true});}
  setKeys(event){
    this.update(event.missing?{missing:true,helperStatus:'missing'}:{input:!!event.input,accessibility:!!event.accessibility,listening:event.listening??null,missing:false,helperStatus:'responsive',lastCheckedAt:event.checkedAt??this.now()});
    this.settleGranted();
  }
  settleGranted(){const kind=this.values.requestKind;if(kind&& (kind==='microphone'?this.values.microphone==='granted':this.values[kind]===true)){clearTimeout(this.actionTimer);clearInterval(this.actionPoll);this.pendingNative=null;this.pendingKind=null;this.update({requestPending:false,requestStatus:'idle',actionError:null});}}
  refresh(){
    let microphone='unknown';try{microphone=this.readMicrophone();}catch{}
    this.update({microphone});this.settleGranted();
    if(this.inflight)return this.inflight;
    this.update({helperStatus:'checking'});
    this.inflight=Promise.resolve().then(()=>this.keys.refreshPermissions()).then(event=>{if(event&&typeof event==='object')this.setKeys(event);return this.state();}).catch(error=>{
      this.update({helperStatus:error.code==='HELPER_UNAVAILABLE'?'missing':'unresponsive',actionError:'Der Tastenhelfer antwortet gerade nicht. Erneut prüfen oder später fortsetzen.'});return this.state();
    }).finally(()=>{this.inflight=null;});return this.inflight;
  }
  watch(active,renew=false){
    if(!active){if(this.timer)clearInterval(this.timer);this.timer=null;this.onChange(this.state());return;}
    if(this.timer&&!renew)return;
    if(this.timer)clearInterval(this.timer);
    this.deadline=this.now()+120000;
    this.timer=setInterval(()=>{if(this.now()>=this.deadline){this.watch(false);return;}void this.refresh();},1000);
    this.timer.unref?.();void this.refresh();this.onChange(this.state());
  }
  async action(kind,openSettings=false){
    if(!Object.hasOwn(PRIVACY_PAGES,kind))throw Error('Unbekannter Freigabeschritt.');
    if(this.pendingByKind.has(kind)&&!openSettings)return this.state();
    if(!openSettings&&kind!=='microphone'&&['missing','unresponsive'].includes(this.values.helperStatus))throw Error('Der Tastenhelfer antwortet nicht. Prüfe erneut oder öffne die passende Systemeinstellung.');
    const id=++this.actionSerial;
    clearTimeout(this.actionTimer);clearInterval(this.actionPoll);
    this.update({requestKind:kind,requestPending:true,requestStatus:'waiting',actionError:null});
    this.actionTimer=setTimeout(()=>{if(id===this.actionSerial){clearInterval(this.actionPoll);this.update({requestPending:false,requestStatus:'timed-out',actionError:'Noch keine Bestätigung. Du kannst später fortsetzen oder den Status erneut prüfen.'});}},this.actionTimeoutMs);
    this.actionTimer.unref?.();
    let operation;
    try{
      if(openSettings)operation=this.openExternal(PRIVACY_PAGES[kind]);
      else if(kind==='microphone'){
        const status=this.readMicrophone();
        operation=status==='not-determined'?this.requestMicrophone():status==='granted'?null:this.openExternal(PRIVACY_PAGES.microphone);
      }else if(kind==='input')operation=this.keys.askInput();else operation=this.keys.askAccessibility();
    }catch(error){operation=Promise.reject(error);}
    const pending=Promise.resolve(operation);
    this.pendingNative=pending;this.pendingKind=kind;
    if(!openSettings)this.pendingByKind.set(kind,pending);
    this.actionPoll=setInterval(()=>{if(!this.closed)void this.refresh();},1000);this.actionPoll.unref?.();
    pending.then(()=>{if(id===this.actionSerial&&!this.closed){clearTimeout(this.actionTimer);clearInterval(this.actionPoll);this.update({requestPending:false,requestStatus:'idle'});void this.refresh();}},()=>{if(id===this.actionSerial&&!this.closed){clearTimeout(this.actionTimer);clearInterval(this.actionPoll);this.update({requestPending:false,requestStatus:'error',actionError:'Die Systemeinstellung konnte nicht geöffnet werden. Bitte erneut prüfen oder später fortsetzen.'});}}).finally(()=>{if(this.pendingNative===pending)this.pendingNative=null;if(this.pendingByKind.get(kind)===pending)this.pendingByKind.delete(kind);});
    this.watch(true,true);
    return this.state();
  }
  close(){this.closed=true;this.actionSerial++;clearTimeout(this.actionTimer);clearInterval(this.actionPoll);this.watch(false);}
}
