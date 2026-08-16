import { createApplication } from '@angular/platform-browser';
import { provideZonelessChangeDetection } from '@angular/core';
import { defineNetApplicationElement } from '@agenticos/net-app-angular';
import { PersonaKanbanComponent } from './persona-kanban.component';

void createApplication({ providers: [provideZonelessChangeDetection()] }).then(application => {
  defineNetApplicationElement('agenticos-persona-kanban-v1', PersonaKanbanComponent, application.injector);
});
