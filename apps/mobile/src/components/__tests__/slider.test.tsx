/// <reference types="jest" />
import { useState } from 'react';
import { fireEvent, render, screen } from '@testing-library/react-native';
import { Platform } from 'react-native';

import { Slider, snapToStep, valueForKey } from '../Slider';

function Harness({
  initial = 50,
  onChange,
  min = 0,
  max = 100,
  step = 5,
  clearable,
}: {
  initial?: number | null;
  onChange?: (v: number) => void;
  min?: number;
  max?: number;
  step?: number;
  clearable?: boolean;
}) {
  const [value, setValue] = useState<number | null>(initial);
  return (
    <Slider
      label="Mental Demands"
      value={value}
      min={min}
      max={max}
      step={step}
      onChange={(v) => {
        setValue(v);
        onChange?.(v);
      }}
      onClear={clearable ? () => setValue(null) : undefined}
      formatValue={(v) => `${v} / ${max}`}
      lowLabel="Very low"
      highLabel="Very high"
      testID="slider"
    />
  );
}

/** Minimal responder event for PanResponder: one touch at page/location x. */
function touchAt(x: number) {
  const touch = { touchActive: true, startPageX: x, startPageY: 0, startTimeStamp: 1, currentPageX: x, currentPageY: 0, currentTimeStamp: 1, previousPageX: x, previousPageY: 0, previousTimeStamp: 1 };
  return {
    nativeEvent: { locationX: x, locationY: 22, pageX: x, pageY: 22, touches: [], changedTouches: [], identifier: 0, timestamp: 1 },
    touchHistory: { numberActiveTouches: 1, indexOfSingleActiveTouch: 0, mostRecentTimeStamp: 1, touchBank: [touch] },
  };
}

/** Taps the track at the position of `v` (the track is laid out 228 pt wide: 200 pt of travel + the 28 pt thumb). */
async function tapAtValue(v: number, min: number, max: number) {
  const track = screen.getByTestId('slider');
  await fireEvent(track, 'layout', { nativeEvent: { layout: { x: 0, y: 0, width: 228, height: 44 } } });
  const x = 14 + ((v - min) / (max - min)) * 200;
  await fireEvent(screen.getByTestId('slider'), 'responderGrant', touchAt(x));
  await fireEvent(screen.getByTestId('slider'), 'responderRelease', touchAt(x));
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

  // UX-3: an unanswered slider shows no thumb/value and the first tap answers, even at the midpoint.
  it('unanswered: no thumb or aria-valuenow, and a tap at the midpoint records an answer', async () => {
    const onChange = jest.fn();
    await render(<Harness initial={null} min={0} max={10} step={1} onChange={onChange} />);
    const slider = screen.getByRole('adjustable', { name: 'Mental Demands' });
    expect(slider.props['aria-valuenow']).toBeUndefined();
    expect(slider).toHaveAccessibilityValue({ text: 'Not answered' });
    expect(screen.queryByTestId('slider-thumb')).toBeNull();

    await tapAtValue(5, 0, 10);
    expect(onChange).toHaveBeenCalledWith(5);
    expect(screen.getByRole('adjustable', { name: 'Mental Demands' })).toHaveAccessibilityValue({ now: 5, text: '5 / 10' });
    expect(screen.getByTestId('slider-thumb')).toBeOnTheScreen();
  });

  it('a tap on an answered slider at its current value does not re-emit', async () => {
    const onChange = jest.fn();
    await render(<Harness initial={5} min={0} max={10} step={1} onChange={onChange} />);
    await tapAtValue(5, 0, 10);
    expect(onChange).not.toHaveBeenCalled();
    await tapAtValue(7, 0, 10);
    expect(onChange).toHaveBeenLastCalledWith(7);
  });

  it('unanswered: the first step answers with the middle of the scale (or startValue)', async () => {
    const onChange = jest.fn();
    await render(<Harness initial={null} onChange={onChange} />);
    await fireEvent.press(screen.getByRole('button', { name: 'Increase Mental Demands' }));
    expect(onChange).toHaveBeenLastCalledWith(50);
    await fireEvent.press(screen.getByRole('button', { name: 'Increase Mental Demands' }));
    expect(onChange).toHaveBeenLastCalledWith(55);
  });

  it('Clear returns an optional answer to unanswered', async () => {
    await render(<Harness initial={7} max={12} step={0.5} clearable />);
    await fireEvent.press(screen.getByRole('button', { name: 'Clear Mental Demands' }));
    expect(screen.getByRole('adjustable', { name: 'Mental Demands' }).props['aria-valuenow']).toBeUndefined();
    expect(screen.queryByRole('button', { name: 'Clear Mental Demands' })).toBeNull();
  });

  // UX-12: on the web the slider is a keyboard tab stop that follows the ARIA slider key pattern.
  it('web: focusable and operable with arrow, page, Home and End keys', async () => {
    jest.replaceProperty(Platform, 'OS', 'web');
    const onChange = jest.fn();
    await render(<Harness initial={null} onChange={onChange} />);
    const slider = () => screen.getByRole('adjustable', { name: 'Mental Demands' });
    expect(slider().props.tabIndex).toBe(0);
    const preventDefault = jest.fn();
    await fireEvent(slider(), 'keyDown', { key: 'ArrowRight', preventDefault });
    expect(onChange).toHaveBeenLastCalledWith(50);
    expect(preventDefault).toHaveBeenCalled();
    await fireEvent(slider(), 'keyDown', { key: 'ArrowRight', preventDefault });
    expect(onChange).toHaveBeenLastCalledWith(55);
    await fireEvent(slider(), 'keyDown', { key: 'PageDown', preventDefault });
    expect(onChange).toHaveBeenLastCalledWith(45);
    await fireEvent(slider(), 'keyDown', { key: 'End', preventDefault });
    expect(onChange).toHaveBeenLastCalledWith(100);
    await fireEvent(slider(), 'keyDown', { key: 'Home', preventDefault });
    expect(onChange).toHaveBeenLastCalledWith(0);
    onChange.mockClear();
    await fireEvent(slider(), 'keyDown', { key: 'a', preventDefault: jest.fn() });
    expect(onChange).not.toHaveBeenCalled();
  });

  it('valueForKey implements the ARIA slider keys', () => {
    const scale = { min: 0, max: 12, step: 0.5, start: 7 };
    expect(valueForKey('ArrowUp', null, scale)).toBe(7);
    expect(valueForKey('ArrowDown', null, scale)).toBe(7);
    expect(valueForKey('ArrowUp', 7, scale)).toBe(7.5);
    expect(valueForKey('ArrowLeft', 0, scale)).toBe(0);
    expect(valueForKey('PageUp', 7, scale)).toBe(8);
    expect(valueForKey('End', null, scale)).toBe(12);
    expect(valueForKey('Tab', 7, scale)).toBeUndefined();
  });

  it('snaps values to the step grid', () => {
    expect(snapToStep(52, 0, 100, 5)).toBe(50);
    expect(snapToStep(53, 0, 100, 5)).toBe(55);
    expect(snapToStep(-10, 0, 100, 5)).toBe(0);
    expect(snapToStep(7.3, 0, 12, 0.5)).toBe(7.5);
    expect(snapToStep(Number.NaN, 0, 10, 1)).toBe(0);
  });
});
