/* 测试用 Solid 桩：signal 是简单容器，store 是普通可变对象 */
export const createSignal = (initial) => {
  let value = initial;
  const getter = () => value;
  getter.set = (v) => { value = typeof v === 'function' ? v(value) : v; };
  const setter = (v) => { value = typeof v === 'function' ? v(value) : v; };
  // Solid 风格：setter 既可接值也可接函数；getter 本身可调用
  return [getter, setter];
};

export const createStore = (initial) => {
  const store = initial;
  // 支持 setState(patchFn) 与 setState('key', value) 两种本项目用到的形式
  const setState = (...args) => {
    if (args.length === 1) {
      const arg = args[0];
      if (typeof arg === 'function') { const next = arg(store); if (next !== undefined) { for (const k of Object.keys(store)) delete store[k]; Object.assign(store, next); } }
      else if (arg && typeof arg === 'object') Object.assign(store, arg);
    } else if (args.length === 2) {
      store[args[0]] = args[1];
    }
  };
  return [store, setState];
};

/* 项目用 reconcile(next, {merge:false}) 表达「整体替换」；桩里直接替换 */
export const reconcile = (next) => (current) => {
        for (const k of Object.keys(current)) delete current[k];
        Object.assign(current, structuredClone(next));
        return undefined;
      };

export const unwrap = (value) => value;
export const createEffect = () => {};
