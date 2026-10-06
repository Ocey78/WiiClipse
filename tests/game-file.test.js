import test from 'node:test'; import assert from 'node:assert/strict';
import {classifyGameFile} from '../src/game-file.js';
test('accepts GameCube disc images',()=>{assert.equal(classifyGameFile('game.iso',10).supported,true); assert.equal(classifyGameFile('game.gcm',10).system,'GameCube');});
test('rejects unsupported files truthfully',()=>{assert.equal(classifyGameFile('game.rvz',10).supported,false);});
