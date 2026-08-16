import { createApplication } from '@angular/platform-browser';
import { provideZonelessChangeDetection } from '@angular/core';
import { defineNetApplicationElement } from '@agenticos/net-app-angular';
import { ApprovalRoomComponent } from './approval-room.component';

void createApplication({ providers: [provideZonelessChangeDetection()] }).then(application => {
  defineNetApplicationElement('agenticos-approval-room-v1', ApprovalRoomComponent, application.injector);
});
