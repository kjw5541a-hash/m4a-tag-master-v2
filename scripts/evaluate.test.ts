import test from 'node:test'
import assert from 'node:assert/strict'
import { bpmVerdict, keyVerdict, parseCsv } from './evaluate.ts'

test('bpmVerdict: ±2% 이내는 ok, 2배·절반은 double·half', () => {
  assert.equal(bpmVerdict(122, 120), 'ok')
  assert.equal(bpmVerdict(240, 120), 'double')
  assert.equal(bpmVerdict(61, 120), 'half')
  assert.equal(bpmVerdict(100, 120), 'wrong')
})

test('keyVerdict: 일치·나란한조·5도·오답', () => {
  assert.equal(keyVerdict('A minor', 'A minor'), 'exact')
  assert.equal(keyVerdict('C major', 'A minor'), 'relative')
  assert.equal(keyVerdict('G major', 'C major'), 'fifth')
  assert.equal(keyVerdict('F major', 'C major'), 'fifth')
  assert.equal(keyVerdict('Gb minor', 'F# minor'), 'exact')
  assert.equal(keyVerdict('D major', 'C major'), 'wrong')
})

test('parseCsv: BOM 제거, 셀 공백 제거', () => {
  const rows = parseCsv('﻿file,bpm,key\r\na.m4a, 120 ,F# minor\r\n\r\n')
  assert.deepEqual(rows, [{ file: 'a.m4a', bpm: 120, key: 'F# minor' }])
})
