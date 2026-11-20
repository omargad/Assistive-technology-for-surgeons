/// <reference types="jest" />
import { useState } from 'react';
import { fireEvent, render, screen } from '@testing-library/react-native';

import { Slider, snapToStep } from '../Slider';

function Harness({ initial = 50, onChange }: { initial?: number; onChange?: (v: number) => void }) {
  const [value, setValue] = useState(initial);
  return (
    <Slider
      label="Mental Demands"
      value={value}
      min={0}
      max={100}
      step={5}
      onChange={(v) => {
        setValue(v);
        onChange?.(v);
      }}
      formatValue={(v) => `${v} / 100`}
      lowLabel="Very low"
      highLabel="Very high"
      testID="slider"
    />
  );
}

const action = (actionName: string) => ({ nativeEvent: { actionName } });

describe('Slider', () => {
  it('is an adjustable control with min/max/now', async () => {
    await render(<Harness />);
    const slider = screen.getByRole('adjustable', { name: 'Mental Demands' });
    expect(slider).toHaveAccessibilityValue({ min: 0, max: 100, now: 50, text: '50 / 100' });
  });

  it('increments and decrements via accessibility actions', async () => {
    const onChange = jest.fn();
    await render(<Harness onChange={onChange} />);
    const slider = screen.getByRole('adjustable', { name: 'Mental Demands' });

    await fireEvent(slider, 'accessibilityAction', action('increment'));
    expect(onChange).toHaveBeenLastCalledWith(55);
    expect(screen.getByRole('adjustable', { name: 'Mental Demands' })).toHaveAccessibilityValue({ now: 55 });

    await fireEvent(screen.getByRole('adjustable', { name: 'Mental Demands' }), 'accessibilityAction', action('decrement'));
    await fireEvent(screen.getByRole('adjustable', { name: 'Mental Demands' }), 'accessibilityAction', action('decrement'));
    expect(onChange).toHaveBeenLastCalledWith(45);
    expect(screen.getByText('45 / 100', { includeHiddenElements: true })).toBeOnTheScreen();
  });

  it('clamps at the ends of the scale', async () => {
    const onChange = jest.fn();
    await render(<Harness initial={100} onChange={onChange} />);
    await fireEvent(screen.getByRole('adjustable', { name: 'Mental Demands' }), 'accessibilityAction', action('increment'));
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByRole('adjustable', { name: 'Mental Demands' })).toHaveAccessibilityValue({ now: 100 });
  });

  it('steps with the −/+ buttons', async () => {
    const onChange = jest.fn();
    await render(<Harness onChange={onChange} />);
    await fireEvent.press(screen.getByRole('button', { name: 'Increase Mental Demands' }));
    await fireEvent.press(screen.getByRole('button', { name: 'Increase Mental Demands' }));
    expect(onChange).toHaveBeenLastCalledWith(60);
    await fireEvent.press(screen.getByRole('button', { name: 'Decrease Mental Demands' }));
    expect(onChange).toHaveBeenLastCalledWith(55);
  });

  it('snaps values to the step grid', () => {
    expect(snapToStep(52, 0, 100, 5)).toBe(50);
    expect(snapToStep(53, 0, 100, 5)).toBe(55);
    expect(snapToStep(-10, 0, 100, 5)).toBe(0);
    expect(snapToStep(7.3, 0, 12, 0.5)).toBe(7.5);
    expect(snapToStep(Number.NaN, 0, 10, 1)).toBe(0);
  });
});
