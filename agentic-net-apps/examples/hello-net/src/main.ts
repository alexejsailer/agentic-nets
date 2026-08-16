import { createApplication } from '@angular/platform-browser';
import { provideZonelessChangeDetection } from '@angular/core';
import { defineNetApplicationElement } from '@agenticos/net-app-angular';
import { HelloNetComponent } from './hello-net.component';

void createApplication({ providers: [provideZonelessChangeDetection()] }).then(application => {
  defineNetApplicationElement('agenticos-hello-net-v1', HelloNetComponent, application.injector);
});
