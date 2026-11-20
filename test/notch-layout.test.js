import test from 'node:test';
import assert from 'node:assert/strict';
import {notchLayout,webScale} from '../core/notch-layout.js';
const display=(x=0,y=25,width=1440,height=875,scaleFactor=2)=>({id:1,scaleFactor,bounds:{x,y:0,width,height:height+y},workArea:{x,y,width,height}});
test('expanded notch is substantially smaller with a full soft-shadow gutter',()=>{const g=notchLayout(display());assert.ok(g.card.width<=672);assert.ok(g.card.height<=490);assert.ok(g.card.x>=80);assert.ok(g.window.height-g.card.y-g.card.height>=80);});
test('layout stays inside negative-coordinate external and small screens',()=>{for(const d of [display(-1920,25,1920,1055,1),display(0,25,390,640,3),display(1440,-900,1280,696,2),display(0,0,320,300,1)]){const g=notchLayout(d),a=d.workArea;assert.ok(g.window.x>=a.x);assert.ok(g.window.y>=a.y);assert.ok(g.window.x+g.window.width<=a.x+a.width);assert.ok(g.window.y+g.window.height<=a.y+a.height);assert.ok(g.card.width>0&&g.card.height>0);}});
test('Retina scale does not double logical geometry',()=>assert.deepEqual(notchLayout(display(0,25,1440,875,1)),notchLayout(display(0,25,1440,875,2))));

test('under the notch the web app is drawn smaller so it keeps its desktop layout; on a small screen it stays as it is',()=>{
  const fit=webScale(notchLayout(display()).card);assert.equal(fit.scale,0.875);assert.equal(fit.width,768);assert.equal(fit.height,560);
  assert.equal(webScale(notchLayout(display(0,25,390,640,3)).card),null);assert.equal(webScale({width:900,height:600}),null);
});
