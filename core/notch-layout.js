// Logical points throughout: Electron handles the physical Retina scale.
// size: the card's size the person pulled it to (decisions 6a and 6b), kept inside the screen; else 672 x 490.
export const CARD_MIN = {width: 480, height: 340};
export function notchLayout(display, size = null) {
  const area=display.workArea;
  const gutter=Math.min(96,Math.max(12,Math.floor((area.width-320)/2)));
  // The card hangs from the strich's own top edge (3 px), so it grows out of the strich, not below it (15.11.2026).
  const top=3,bottom=Math.min(96,Math.max(12,Math.floor(area.height*.12)));
  // 672 x 490: wide enough that the web app, drawn at 7/8 of its size, shows its desktop layout (webScale below).
  const width=Math.max(1,Math.min(Math.max(CARD_MIN.width,Math.round(size?.width??672)),area.width-2*gutter));
  const height=Math.max(1,Math.min(Math.max(CARD_MIN.height,Math.round(size?.height??490)),area.height-top-bottom));
  return {window:{x:Math.round(area.x+(area.width-width-2*gutter)/2),y:area.y,width:width+2*gutter,height:height+top+bottom},card:{x:gutter,y:top,width,height},gutter};
}
// The web app shows its desktop layout (carousel on top, sidebars) from 768 px on and the phone layout with the
// bar at the bottom below that. Under the notch it is a laptop, never a phone (14.11.2026): the page is drawn a
// little smaller, so that it is 768 px wide for itself. Null where that would make it too small to read.
export const WEB_DESKTOP_WIDTH=768;
export function webScale(card){
  const scale=card.width/WEB_DESKTOP_WIDTH;
  if(scale>=1||scale<0.8)return null;
  return {scale,width:WEB_DESKTOP_WIDTH,height:Math.round(card.height/scale)};
}
export const inside = (point,rect)=>point.x>=rect.x&&point.x<=rect.x+rect.width&&point.y>=rect.y&&point.y<=rect.y+rect.height;
