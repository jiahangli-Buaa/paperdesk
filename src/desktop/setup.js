window.paperdesk.onSetupProgress(event=>{
  document.getElementById('status').textContent=event.label+(event.percent===null?'':` · ${event.percent}%`);
  const bar=document.getElementById('bar');bar.classList.toggle('known',event.percent!==null);
  bar.style.width=event.percent===null?'30%':`${event.percent}%`;
});
