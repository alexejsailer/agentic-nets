import { bootstrapApplication } from '@angular/platform-browser';
import { provideZonelessChangeDetection } from '@angular/core';
import { DevHostComponent } from './dev-host.component';

void bootstrapApplication(DevHostComponent, { providers: [provideZonelessChangeDetection()] });
