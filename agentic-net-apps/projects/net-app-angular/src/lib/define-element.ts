import { Injector, Type } from '@angular/core';
import { createCustomElement } from '@angular/elements';

/** Register an Angular component as the single browser-native entry point Studio can mount. */
export function defineNetApplicationElement(
  elementName: string,
  component: Type<unknown>,
  injector: Injector,
): void {
  if (!elementName.includes('-')) throw new Error('Custom element names must contain a dash.');
  if (customElements.get(elementName)) return;
  customElements.define(elementName, createCustomElement(component, { injector }));
}
