import React, { useEffect, useRef, useState } from 'react';
import { AccessibilityInfo, Animated, Easing } from 'react-native';
import { SvgXml } from 'react-native-svg';
import ICONOS from '../status/data.js';
export function StatusIcon({ kind = 'paused', size = 16, color, label, style, reducedMotion = false, duration = 900 }) {
  const [systemReduced, setSystemReduced] = useState(false);
  const rotation = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    let live = true;
    AccessibilityInfo.isReduceMotionEnabled().then((v) => { if (live) setSystemReduced(v); });
    const sub = AccessibilityInfo.addEventListener('reduceMotionChanged', setSystemReduced);
    return () => { live = false; sub.remove(); };
  }, []);
  useEffect(() => {
    rotation.setValue(0);
    if (kind !== 'working' || systemReduced || reducedMotion) return;
    const loop = Animated.loop(Animated.timing(rotation, { toValue: 1, duration, easing: Easing.linear, useNativeDriver: true }));
    loop.start();
    return () => loop.stop();
  }, [kind, systemReduced, reducedMotion, duration, rotation]);
  const icon = <SvgXml xml={ICONOS[kind] || ICONOS.paused} width={size} height={size} color={color} accessible={!!label} accessibilityLabel={label} />;
  return kind === 'working' ? <Animated.View style={[style, { transform: [{ rotate: rotation.interpolate({ inputRange: [0, 1], outputRange: ['0deg', '360deg'] }) }] }]}>{icon}</Animated.View> : <Animated.View style={style}>{icon}</Animated.View>;
}
