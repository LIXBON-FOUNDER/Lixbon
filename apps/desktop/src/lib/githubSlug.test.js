import { describe, expect, it } from 'vitest';
import { githubSlug } from './githubSlug';

describe('githubSlug', () => {
  it.each([
    ['https://github.com/Owner/Repo.git', 'owner/repo'],
    ['https://github.com/Owner/Repo', 'owner/repo'],
    ['https://www.github.com/o/r/', 'o/r'],
    ['git@github.com:Owner/Repo.git', 'owner/repo'],
    ['git://github.com/o/r.git', 'o/r'],
    ['ssh://git@github.com/o/r.git', 'o/r'],
    ['ssh://git@github.com:22/o/r.git', 'o/r'],
    ['https://user:token@github.com/o/r.git', 'o/r'],
    ['https://GitHub.com/o/r', 'o/r'],
    ['github.com/o/r', 'o/r'],
    ['owner/repo', 'owner/repo'],
    ['  o/r.git  ', 'o/r'],
    ['https://github.com/o/r/pull/12', 'o/r'],
    ['https://github.com/o/mi.repo_x-1', 'o/mi.repo_x-1'],
  ])('%s -> %s', (entrada, esperado) => {
    expect(githubSlug(entrada)).toBe(esperado);
  });

  it.each([
    [''],
    [null],
    [undefined],
    ['solo-owner'],
    ['https://github.com/solo-owner'],
    ['https://gitlab.com/o/r.git'],
    ['git@gitlab.com:o/r.git'],
    ['gitlab.com/o/r'],
    ['https://evil.com/github.com/o/r'],
    ['https://github.com.evil.io/o/r'],
    ['https://evil-github.com/o/r'],
    ['https://github.com@evil.com/o/r'],
    ['git@evil.com:github.com/o/r'],
    ['https://'],
  ])('rechaza %s', (entrada) => {
    expect(githubSlug(entrada)).toBe('');
  });
});
