'use strict';
// The header: the page title and summary, the project tab bar with its sliding indicator, and the AI sparkles of the shell.
// Static shell markup marks its AI sparkles with data-sparkle; they are drawn by the one shared sparkle.
for (const slot of document.querySelectorAll('[data-sparkle]')) { slot.insertAdjacentHTML('beforebegin', window.AIWSUI.sparkle(slot.dataset.sparkle)); slot.remove(); }
// Several parts of a render may set the page header; it is written once afterwards, so a changed title crossfades once.
let renderingShell=false,pageHeader=null;
function setPageHeader(crumb,summary='',showTitle=true){pageHeader={crumb,summary,showTitle};if(!renderingShell)commitPageHeader();}
function commitPageHeader(){if(!pageHeader)return;const {crumb,summary,showTitle}=pageHeader,element=$('#page-summary');pageHeader=null;$('#breadcrumb').hidden=!showTitle;window.AIWSUI.motion.swapText($('#breadcrumb-project'),crumb);window.AIWSUI.motion.swapText(element,summary);element.title=summary;element.hidden=!summary;}
/** Adds or removes a project tab's status dot. */
function markProjectTab(element,on,tone,label){const dot=element.querySelector('.ui-dot');if(on&&!dot)element.insertAdjacentHTML('beforeend',`<span class="ui-dot" data-tone="${tone}" role="img" aria-label="${esc(globalThis.AIWSI18n.text(label))}"></span>`);else if(!on)dot?.remove();}
/** Shows the project tabs on a project's board and marks the active one; the terminal tab carries a live dot while a terminal runs,
 * and the editor tab shows only while files are open, with a dot while any of them is unsaved. */
function renderProjectTabBar(){
  const current=project(),overview=activeScreen==='overview';$('#project-view-tabs').hidden=overview?false:activeScreen!=='board'||!current;
  for(const tab of overviewTabs){const element=$(`#overview-tab-${tab}`),active=overview&&overviewTab()===tab;element.hidden=!overview;element.classList.toggle('active',active);element.setAttribute('aria-selected',String(active));element.tabIndex=active?0:-1;}
  const slot=$('#plugin-project-tabs');if(slot)slot.hidden=overview;
  for(const tab of projectTabs){
    const element=$(`#project-tab-${tab}`),active=projectTab()===tab;element.hidden=overview||tab==='settings'&&Boolean(current?.general)||tab==='editor'&&!projectEditor(current)?.hasFiles();element.classList.toggle('active',active);element.setAttribute('aria-selected',String(active));element.tabIndex=active?0:-1;
    if(tab==='terminal')markProjectTab(element,projectTerminalsRunning(projectId),'done','Terminal çalışıyor');
    if(tab==='editor')markProjectTab(element,Boolean(projectEditor(current)?.hasUnsaved()),'needs','Kaydedilmemiş değişiklikler');
  }
}
// The active project tab's underline is placed when the active tab changes and whenever the tabs resize (fonts loading, a
// language change, a collapsing sidebar), so it never keeps a stale position; a CSS transition glides it once it is placed.
// Renders that keep the same tab do not measure: reading a layout right after a render forces the whole page's layout.
let projectTabIndicatorAt='',projectTabIndicatorFor=null;
function placeProjectTabIndicator(measure=false){
  const nav=$('#project-view-tabs'),indicator=$('.project-tabs-indicator',nav),active=[...nav.querySelectorAll('.view-tab.active')].find(tab=>!tab.closest('[hidden]'));
  if(nav.hidden||!active){indicator.classList.remove('is-placed');projectTabIndicatorAt='';projectTabIndicatorFor=null;return;}
  if(!measure&&active===projectTabIndicatorFor)return;
  projectTabIndicatorFor=active;
  // A tab without a box (an ancestor is hidden) is placed by the resize observer once it has one.
  if(!active.offsetWidth){indicator.classList.remove('is-placed');projectTabIndicatorAt='';return;}
  const first=!indicator.classList.contains('is-placed'),transform=`translateX(${active.offsetLeft}px) scaleX(${active.offsetWidth})`;
  if(transform!==projectTabIndicatorAt){indicator.style.transform=transform;projectTabIndicatorAt=transform;}
  if(first){void indicator.offsetWidth;indicator.classList.add('is-placed');}
}
if(typeof ResizeObserver==='function'){const nav=$('#project-view-tabs');const observer=new ResizeObserver(()=>placeProjectTabIndicator(true));observer.observe(nav);for(const tab of nav.querySelectorAll('.view-tab'))observer.observe(tab);}
