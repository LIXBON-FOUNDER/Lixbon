export function dismissSheet(distance, velocityPerMs) {
  'worklet';
  return distance > 0 && (distance >= 120 || velocityPerMs > 0.4);
}
export function sheetDrag(distance) {
  'worklet';
  return distance < 0 ? distance * 0.2 : distance;
}
