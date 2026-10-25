import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react';
import { useStore } from './store';
import { PendingDock } from './ade/Composer';
import MobileApp from './mobile/MobileApp';
import ReviewViewer from './ade/ReviewViewer';
import AdeDesktop from './ade/AdeDesktop';
import { runCommand } from './cli/CliTerminal';
import CompareAttempts from './ade/CompareAttempts';
vi.setConfig({ testTimeout: 60000 });
const st=()=>useStore.getState();
beforeEach(()=>st().resetAll());
afterEach(cleanup);
describe('hierarchy continuity',()=>{
 it('review round trip preserves Attempt, comments and lifecycle',()=>{
  const state=st().attempts.find(a=>a.id==='att_oa_b').state;
  st().addComment('att_oa_b','src/auth/token.ts',38,'Check rotation');
  st().openReview('att_oa_b');
  expect(st().surface).toBe('ide'); expect(st().mockUi.ideReviewOpen).toBe(true);
  st().openProof('att_oa_b'); st().openReview('att_oa_b');
  expect(st().sel.attemptId).toBe('att_oa_b');
  expect(st().review('att_oa_b').comments[0].text).toBe('Check rotation');
  expect(st().attempts.find(a=>a.id==='att_oa_b').state).toBe(state);
 });
 it('folding queued work preserves order and origin',()=>{
  st().send({attemptId:'att_rt_a',text:'Queued from CLI',mode:'queue',from:'CLI'});
  const ids=st().pending.att_rt_a.map(p=>p.id);
  render(<PendingDock attemptId="att_rt_a" />);
  expect(screen.queryByText('Queued from CLI')).toBeNull();
  fireEvent.click(screen.getByRole('button',{name:/PENDING/}));
  expect(screen.getByText('Queued from CLI')).toBeTruthy();
  expect(st().pending.att_rt_a.map(p=>p.id)).toEqual(ids);
  expect(st().pending.att_rt_a.at(-1).from).toBe('CLI');
 });
 it('acceptance is pending integration, never a real merge',()=>{
  st().decide('att_oa_b','accepted');
  expect(st().attempts.find(a=>a.id==='att_oa_b').integrationStatus).toBe('pending');
 });
 it('mobile separates connection and execution host',()=>{
  st().mOpen('approval',{id:'at_net_ch'}); render(<MobileApp />);
  expect(screen.getByText('Executes on')).toBeTruthy();
  expect(screen.getByText(/Connected to Desktop-PC/)).toBeTruthy();
  expect(screen.getAllByText('VPS-01').length).toBeGreaterThan(0);
 });
 it('mobile starts with decisions and falls back to calm summary',()=>{
  st().setSurface('mobile'); expect(st().mobile.tab).toBe('attention');
  useStore.setState({attention:[],mobile:{tab:'home',stack:[]}}); st().setSurface('mobile');
  render(<MobileApp />); expect(screen.getByText('No decisions pending')).toBeTruthy();
  fireEvent.click(screen.getByRole('button',{name:'Work',exact:true}));
  expect(screen.getByText('Agent Runtime', { selector: 'summary b' })).toBeTruthy();
 });
 it('review file and unsent draft survive the Desktop round trip',()=>{
  st().select('att_oa_b','review');
  const first=render(<ReviewViewer embedded />);
  fireEvent.click(screen.getByRole('button',{name:/src\/auth\/store.ts/}));
  const comment=screen.getAllByRole('button',{name:/Comment on line/})[0];
  fireEvent.click(comment); fireEvent.change(screen.getByPlaceholderText(/Comment on line/),{target:{value:'Draft stays here'}});
  first.unmount(); st().openProof('att_oa_b'); st().openReview('att_oa_b'); render(<ReviewViewer embedded />);
  expect(screen.getByPlaceholderText(/Comment on line/).value).toBe('Draft stays here');
  expect(st().review('att_oa_b').ui.path).toBe('src/auth/store.ts');
 });
 it('review shortcut uses the current Attempt rather than the initial selection',()=>{
  render(<AdeDesktop />);
  act(()=>st().select('att_oa_b'));
  fireEvent.keyDown(window,{key:'R',ctrlKey:true,shiftKey:true});
  expect(st().sel.attemptId).toBe('att_oa_b'); expect(st().surface).toBe('ide');
 });
 it('CLI opening the IDE returns to editing after a review',()=>{
  st().openReview('att_oa_b'); runCommand('lxo open att_rt_a --ide',st());
  expect(st().sel.attemptId).toBe('att_rt_a'); expect(st().mockUi.ideReviewOpen).toBe(false);
 });
 it('sending review feedback opens the next round since the last review',()=>{
  st().addComment('att_oa_b','src/auth/token.ts',38,'Fix rotation');
  st().patchReview('att_oa_b',{ui:{filter:'all',draft:'old draft'}}); st().sendReview('att_oa_b');
  expect(st().review('att_oa_b').ui.filter).toBe('since'); expect(st().review('att_oa_b').ui.draft).toBe('');
 });
 it('equal test ratios have no exclusive winner',()=>{
  st().select('att_oa_b','compare'); render(<CompareAttempts />);
  const tests=screen.getByText('Tests').parentElement;
  expect(tests.querySelector('[title="Best of the set"]')).toBeNull();
  expect(screen.getByText(/Provisional comparison/)).toBeTruthy();
 });
});



