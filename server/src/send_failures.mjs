// Fixed classifications only. Native wording may contain message bodies, file
// bytes, credentials or URLs and is never persisted or returned.
export function describeSendFailure(response){
 const text=(typeof response?.message==='string'?response.message.slice(0,8192):typeof response?.wording==='string'?response.wording.slice(0,8192):'').replace(/^Error:\s*/,'');
 const definitions=[['file_name_too_long',/\bENAMETOOLONG\b/],['file_not_found',/\bENOENT\b/],['permission_denied',/\b(?:EACCES|EPERM)\b/],['invalid_argument_type',/\bERR_INVALID_ARG_TYPE\b/],['invalid_argument_value',/\bERR_INVALID_ARG_VALUE\b/],['out_of_range',/\bERR_OUT_OF_RANGE\b/],['resource_limit',/\b(?:ENOMEM|ENOSPC|EMFILE)\b/],['upstream_timeout',/\b(?:ETIMEDOUT|TimeoutError)\b|超时/],['unsupported_file_type',/unsupported (?:file|image) type|不支持的(?:文件|图片)类型/i],['file_processing_failed',/^文件处理失败(?::|：)/],['file_parameter_missing',/^文件消息缺少参数$/]];
 definitions.push(['type_error',/\bTypeError\b/],['range_error',/\bRangeError\b/],['missing_native_module',/\bMODULE_NOT_FOUND\b|Cannot find module|shared object/i],['native_file_copy_failure',/copyFile|复制文件失败/],['native_image_metadata_failure',/getRichMediaFilePathForGuild|picWidth|picHeight|图片尺寸|图片宽高/],['voice_conversion_failed',/^语音转换失败[,，]/]);
 const causes=definitions.filter(([,pattern])=>pattern.test(text)).map(([name])=>name);
 // These exact errors originate in handleOb11FileLikeMessage before the
 // message segments are prepared and before MsgApi.sendMsg is called.
 const definitivePreSend=causes.includes('file_processing_failed')||causes.includes('file_parameter_missing')||causes.includes('voice_conversion_failed');
 return Object.freeze({retcode:Number.isSafeInteger(response?.retcode)?response.retcode:null,reason:causes[0]??'unclassified_native_rejection',cause_codes:Object.freeze(causes),definitive_pre_send:definitivePreSend});
}
export class UpstreamSendFailure extends Error{
 constructor(description){super('upstream send rejected');this.name='UpstreamSendFailure';this.description=description;this.definitivePreSend=description.definitive_pre_send===true;}
}
export const SEND_REJECTION_CODES=Object.freeze(['upstream_pre_send_rejected','invalid_audio','audio_too_large','audio_type_mismatch','invalid_audio_streams','unsupported_audio_parameters','audio_too_long','audio_too_short','audio_unavailable','audio_processing_timeout','audio_busy','audio_staging_failed','invalid_audio_decoder_response','account_identity_mismatch','conversation_forbidden']);
export function recordPreSendRejection(store,requestId,errorCode){
 if(!SEND_REJECTION_CODES.includes(errorCode))return false;const row=store.db.prepare('SELECT body_hash,state FROM sends WHERE request_id=?').get(requestId);if(!row||row.state!=='pending')return false;
 store.db.exec('CREATE TABLE IF NOT EXISTS tool_send_rejections(request_id TEXT PRIMARY KEY,body_hash TEXT NOT NULL,error_code TEXT NOT NULL)');store.db.prepare('INSERT OR IGNORE INTO tool_send_rejections VALUES(?,?,?)').run(requestId,row.body_hash,errorCode);return true;
}
export function rejectedDelivery(store,requestId,bodyHash){
 if(!store?.db?.prepare||!store.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='tool_send_rejections'").get())return null;
 const row=store.db.prepare('SELECT body_hash,error_code FROM tool_send_rejections WHERE request_id=?').get(requestId);
 return row&&row.body_hash===bodyHash&&SEND_REJECTION_CODES.includes(row.error_code)?{request_id:requestId,state:'rejected',message_id:null,error:row.error_code}:null;
}
