/** Standalone function also serialized into the public SDK; no secrets or module closures. */
export function responsiveImageBounds(width:unknown,height:unknown){
 const w=typeof width==='number'&&Number.isFinite(width)&&width>0?width:0;
 const h=typeof height==='number'&&Number.isFinite(height)&&height>0?height:0;
 const scale=w&&h?Math.min(1,970/w,600/h):w?Math.min(1,970/w):1;
 return {width:w?Math.round(w*scale*1000)/1000:0,height:w&&h?Math.round(h*scale*1000)/1000:0,intrinsicWidth:w,intrinsicHeight:h,ratio:w&&h?w+' / '+h:null};
}
