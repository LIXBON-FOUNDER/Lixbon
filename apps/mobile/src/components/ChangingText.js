import React, { useEffect, useRef } from 'react';
import { Animated, View } from 'react-native';
import { Text } from './Typography';
import { useReducedMotion } from './motionPreference';
import { MOTION } from '../theme';
const MotionText = Animated.createAnimatedComponent(Text);
export function ChangingText({ children, style, ...props }) {
  const opacity = useRef(new Animated.Value(1)).current;
  const previous = useRef(children);
  const reduced = useReducedMotion();
  useEffect(() => {
    if (previous.current === children) return;
    previous.current = children;
    opacity.setValue(0);
    Animated.timing(opacity, { toValue: 1, duration: MOTION.fade, useNativeDriver: true }).start();
  }, [children, opacity]);
  return <View style={{ flexShrink: 1 }}>
    <MotionText {...props} style={[style, { opacity }]}>{children}</MotionText>
    {!reduced && <MotionText {...props} accessible={false} importantForAccessibility="no-hide-descendants" style={[style, { position: 'absolute', top: 0, left: 0, filter: [{ blur: 2 }], opacity: opacity.interpolate({ inputRange: [0, 1], outputRange: [1, 0] }) }]}>{children}</MotionText>}
  </View>;
}
