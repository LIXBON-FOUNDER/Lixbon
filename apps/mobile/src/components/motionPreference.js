import { useEffect, useState } from 'react';
import { AccessibilityInfo } from 'react-native';
import { UI_DEFAULTS, usePrefs } from '../state';
export function useReducedMotion() {
  const ui = usePrefs()?.ui || UI_DEFAULTS;
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    let live = true;
    AccessibilityInfo.isReduceMotionEnabled().then((v) => { if (live) setReduced(v); }).catch(() => {});
    const sub = AccessibilityInfo.addEventListener('reduceMotionChanged', setReduced);
    return () => { live = false; sub?.remove(); };
  }, []);
  return reduced || !ui.motion;
}
