import test from 'node:test';
import assert from 'node:assert/strict';
import {eventsToCsv} from '../src/production.js';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
const source=readFileSync(new URL('../src/app.js',import.meta.url),'utf8');
function storageHarness(initial){
 const values=new Map([['application-bobines-v1',initial]]);
 const context={localStorage:{getItem:k=>values.get(k)??null,setItem:(k,v)=>values.set(k,v)},KEY:'application-bobines-v1',migrate:v=>v??{},toast:()=>{},state:{replaced:true}};
 const start=source.indexOf('function loadState()');const end=source.indexOf('// Synchronisation entre onglets');
 let segment=source.slice(start,end);segment=segment.replace(/let state = loadState\(\);[\s\S]*?(?=function save\()/,'state = loadState();\n');
 vm.runInNewContext(segment,context);return {values,context};
}
test('JSON illisible conservé sans écrasement au démarrage ni à la sauvegarde',()=>{
 const original='{"lines": broken';const {values,context}=storageHarness(original);assert.equal(values.get('application-bobines-v1'),original);vm.runInNewContext('save()',context);assert.equal(values.get('application-bobines-v1'),original);
});
test('données valides toujours sauvegardées',()=>{const {values}=storageHarness('{"events":[]}');assert.equal(JSON.parse(values.get('application-bobines-v1')).events.length,0);});
for(const value of ['=1+1','+SUM(1)','-1+1','@SUM(1)','\t=1+1',' =1+1'])test('CSV neutralise '+JSON.stringify(value),()=>{
 const csv=eventsToCsv([{declaredAt:0,recordedAt:0,shiftId:'test',operatorNumber:value,lineNumber:4,ofNumber:value,type:'start'}]);assert.ok(csv.includes("'"+value));
});
