import React from 'react';

export const Button = React.forwardRef(({
  className = '',
  variant = 'primary',
  size = 'md',
  children,
  type = 'button',
  ...props
}, ref) => {
  const classes = [
    variant !== 'primary' ? variant : '',
    size !== 'md' ? size : '',
    className
  ].filter(Boolean).join(' ');

  return (
    <button
      ref={ref}
      type={type}
      className={classes}
      {...props}
    >
      {children}
    </button>
  );
});

Button.displayName = "Button";
