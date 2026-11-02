/** Standalone function also serialized into the public SDK; no secrets or module closures. */
export function responsiveImageBounds(width:unknown,height:unknown,maxWidth=728,maxHeight=250){
 const w=typeof width==='number'&&Number.isFinite(width)&&width>0?width:0;
 const h=typeof height==='number'&&Number.isFinite(height)&&height>0?height:0;
 const limitW=Number.isFinite(maxWidth)&&maxWidth>0?Math.min(maxWidth,970):728;
 const limitH=Number.isFinite(maxHeight)&&maxHeight>0?Math.min(maxHeight,600):250;
 const scale=w&&h?Math.min(1,limitW/w,limitH/h):w?Math.min(1,limitW/w):1;
 return {width:w?Math.round(w*scale*1000)/1000:0,height:w&&h?Math.round(h*scale*1000)/1000:0,intrinsicWidth:w,intrinsicHeight:h,ratio:w&&h?w+' / '+h:null};
}
