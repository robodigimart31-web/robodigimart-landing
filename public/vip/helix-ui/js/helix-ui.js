/* Optional UI-only helpers. No backend or authentication side effects. */
(function(){'use strict';
  const base='/vip/helix-ui/icons/';
  window.HelixUI={
    icon(name,alt=''){const img=document.createElement('img');img.className='hx-icon';img.src=base+encodeURIComponent(name)+'.svg';img.alt=alt;img.loading='lazy';return img;},
    toast(message){const el=document.createElement('div');el.className='hx-toast';el.setAttribute('role','status');el.textContent=String(message);document.body.appendChild(el);setTimeout(()=>el.remove(),2800);},
    dialog({title='Konfirmasi',message='',confirmText='OK',onConfirm}={}){
      const wrap=document.createElement('div');wrap.className='hx-dialog-backdrop';
      const d=document.createElement('section');d.className='hx-dialog';d.setAttribute('role','dialog');d.setAttribute('aria-modal','true');
      const h=document.createElement('h2');h.textContent=title;h.style.marginTop='0';d.appendChild(h);
      const p=document.createElement('p');p.textContent=message;d.appendChild(p);
      const row=document.createElement('div');row.style.cssText='display:flex;gap:8px;justify-content:flex-end;margin-top:20px';
      const cancel=document.createElement('button');cancel.className='hx-btn';cancel.textContent='Batal';
      const ok=document.createElement('button');ok.className='hx-btn hx-btn--primary';ok.textContent=confirmText;
      const close=()=>{document.removeEventListener('keydown',key);wrap.remove()};
      const key=e=>{if(e.key==='Escape')close()};
      cancel.onclick=close;ok.onclick=()=>{close();if(typeof onConfirm==='function')onConfirm()};
      row.append(cancel,ok);d.appendChild(row);wrap.appendChild(d);wrap.addEventListener('click',e=>{if(e.target===wrap)close()});document.addEventListener('keydown',key);document.body.appendChild(wrap);cancel.focus();
    }
  };
})();
