import webpush from 'npm:web-push@3.6.7';
import { createPushHandler } from './handler.js';
Deno.serve(createPushHandler({
  env:(name:string)=>Deno.env.get(name),
  generateRequestDetails:(subscription:unknown,payload:string,options:unknown)=>webpush.generateRequestDetails(subscription,payload,options)
}));
