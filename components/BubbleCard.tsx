
import React from 'react';

interface BubbleCardProps {
  children: React.ReactNode;
  className?: string;
}

export const BubbleCard: React.FC<BubbleCardProps> = ({ children, className = "" }) => {
  return (
    <div className={`bg-white bg-opacity-90 backdrop-blur-md rounded-[2.5rem] p-8 bubble-shadow border-4 border-white ${className}`}>
      {children}
    </div>
  );
};

export const BubbleButton: React.FC<{
  onClick?: () => void;
  children: React.ReactNode;
  variant?: 'primary' | 'secondary' | 'danger';
  className?: string;
  disabled?: boolean;
}> = ({ onClick, children, variant = 'primary', className = "", disabled }) => {
  const variants = {
    primary: 'bg-yellow-400 hover:bg-yellow-500 text-yellow-900 border-yellow-200',
    secondary: 'bg-blue-400 hover:bg-blue-500 text-white border-blue-200',
    danger: 'bg-pink-500 hover:bg-pink-600 text-white border-pink-200'
  };

  return (
    <button
      disabled={disabled}
      onClick={onClick}
      className={`
        px-6 py-3 rounded-full font-bold transition-all transform active:scale-95 
        border-b-4 shadow-lg disabled:opacity-50 disabled:cursor-not-allowed
        ${variants[variant]} ${className}
      `}
    >
      {children}
    </button>
  );
};
