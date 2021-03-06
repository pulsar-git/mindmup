/*global jQuery, MM, _ */
/**
 * Utility class that implements the workflow for requesting an export and polling for results.
 *
 * ## Export workflow
 *
 * MindMup.com supports several server processes that convert map (or layout) files into other formats (images, slides etc).
 * These server side resources require a valid Gold license for storage and billing, so the access is controlled
 * using the {{#crossLink "GoldApi"}}{{/crossLink}}. The general workflow to order an export is:
 *
 * 1. Ask the Gold API for an upload token for a particular upload format.
 *    The Gold API will reply with all information required to upload a file to
 *    Amazon S3, as well as signed URLs to check for the conversion result or error
 * 2. Upload the source content to Amazon S3. Note that some formats require a layout, some require an entire map.
 * 3. Poll the result and error URLs periodically. If the file appears on the result URL, download it and send to users. If
 *    a file appears on the error URL or nothing appears until the polling timeout, fail and stop polling
 *
 * This class coordinates all the complexity of the workflow and conversions in a simple convenience method.
 *
 * ## Export formats
 *
 * Currently supported formats are:
 *    * pdf - the map file as a scalable vector PDF
 *    * png - the map as a bitmap image (PNG)
 *    * presentation.pdf - the slideshow as a scalable vector PDF
 *    * presentation.pptx - the slideshow as a PowerPoint file
 *    * storyboard.docx - the slideshow as a PowerPoint file
 *
 * In general, the exporters do not work on raw map files, but on layouts already positioned by the client browser. The pdf and png
 * export formats require a map layout to be uploaded to the server. The storyboard exporters require a JSON version of the storyboard.
 * There are several utility functions that generate the appropriate content for each format. For an example of how to generate the
 * right data to send it up, see https://github.com/mindmup/mindmup/blob/master/public/main.js
 *
 * ### Additional properties
 *
 * The PDF format requires the following additional properties to be specified when starting the export
 *
 *     {export: {'orientation': String, 'page-size': String, 'margin': int }}
 *
 * * orientation can be either 'portrait' or 'landscape'
 * * page-size can be A0, A1, A2, A3, A4, A5
 *
 * @class LayoutExportController
 * @constructor
 * @param {Object} exportFunctions a hash-map _format -> function_ that produces a JSON object which will be uploaded to the server
 * @param {Object} configurationGenerator object implementing the following API (for example a {{#crossLink "GoldApi"}}{{/crossLink}} instance)
 * @param {function} configurationGenerator.generateExportConfiguration (String format)
 * @param {Object} storageApi object implementing the following API (for example a {{#crossLink "S3Api"}}{{/crossLink}} instance):
 * @param {function} storageApi.save (String content, Object configuration, Object properties)
 * @param {function} storageApi.poll (URL urlToPoll, Object options)
 * @param {ActivityLog} activityLog logging interface
 */
MM.LayoutExportController = function (formatFunctions, configurationGenerator, storageApi, activityLog) {
	'use strict';
	var self = this,
		category = 'Map',
		getEventType = function (format) {
			if (!format) {
				return 'Export';
			}
			return format.toUpperCase() + ' Export';
		},
		getExportFunction = function (format) {
			return formatFunctions[format].exporter || formatFunctions[format];
		},
		postProcess = function (format, url, exportProperties) {
			var result = {'output-url': url};
			if (formatFunctions[format].processor) {
				return formatFunctions[format].processor(_.extend(result, exportProperties));
			}
			return jQuery.Deferred().resolve(result).promise();
		};
    /**
     * Kick-off an export workflow
     *
     * This method will generate the content to export by calling the appropriate export function, merge optional
     * generic data with the result, upload the document to the server and poll until it receives an error or a result
     *
     * @method startExport
     * @param {String} format one of the supported formats, provided in the constructor
     * @param [exportProperties] any generic properties that will be merged into the object generated by an export function before uploading
     * @return {jQuery.Deferred} a jQuery promise that will be resolved with the URL of the exported document if successful
     */
	self.startExport = function (format, exportProperties) {
		var deferred = jQuery.Deferred(),
			eventType = getEventType(format),
			isStopped = function () {
				return deferred.state() !== 'pending';
			},
			reject = function (reason, fileId) {
				activityLog.log(category, eventType + ' failed', reason);
				deferred.reject(reason, fileId);
			},
			progress = function (progressEvent) {
				deferred.notify('Uploading ' + (progressEvent || ''));
			},
			exported = getExportFunction(format)(),
			layout = _.extend({}, exported, exportProperties);
		if (_.isEmpty(exported)) {
			return deferred.reject('empty').promise();
		}
		activityLog.log(category, eventType + ' started');
		deferred.notify('Setting up the export');
		configurationGenerator.generateExportConfiguration(format).then(
			function (exportConfig) {
				var fileId = exportConfig.s3UploadIdentifier;
				storageApi.save(JSON.stringify(layout), exportConfig, {isPrivate: true}).then(
					function () {
						var pollTimer = activityLog.timer(category, eventType + ':polling-completed'),
							pollTimeoutTimer = activityLog.timer(category, eventType + ':polling-timeout'),
							pollErrorTimer = activityLog.timer(category, eventType + ':polling-error'),
							resolve = function () {
								pollTimer.end();
								activityLog.log(category, eventType + ' completed');
								postProcess(format, exportConfig.signedOutputUrl, exportProperties).then(function (result) {
									deferred.resolve(result, fileId);
								}, function (reason) {
									reject(reason, fileId);
								});
							};
						deferred.notify('Processing your export');
						storageApi.poll(exportConfig.signedErrorListUrl, {stoppedSemaphore: isStopped, sleepPeriod: 15000}).then(
							function () {
								pollErrorTimer.end();
								reject('generation-error', fileId);
							});
						storageApi.poll(exportConfig.signedOutputListUrl, {stoppedSemaphore: isStopped, sleepPeriod: 2500}).then(
							resolve,
							function (reason) {
								pollTimeoutTimer.end();
								reject(reason, fileId);
							});
					},
					reject,
					progress
				);
			},
			reject
		);
		return deferred.promise();
	};
};

jQuery.fn.layoutExportWidget = function (layoutExportController) {
	'use strict';
	return this.each(function () {
		var self = jQuery(this),
			selectedFormat = function () {
				var selector = self.find('[data-mm-role=format-selector]');
				if (selector && selector.val()) {
					return selector.val();
				} else {
					return self.data('mm-format');
				}
			},
			confirmElement = self.find('[data-mm-role~=start-export]'),
			setState = function (state) {
				self.find('.visible').hide();
				self.find('.visible' + '.' + state).show().find('[data-mm-show-focus]').focus();
				self.trigger(jQuery.Event('stateChanged', {'state': state}));
			},
			publishResult = function (result) {
				_.each(result, function (value, key) {
					self.find('[data-mm-role~=' + key + ']').each(function () {
						var element = jQuery(this);
						if (element.prop('tagName') === 'A') {
							element.attr('href', value);
						} else if (element.prop('tagName') === 'INPUT' || element.prop('tagName') === 'TEXTAREA') {
							element.val(value).attr('data-mm-val', value);
						} else if (element.prop('tagName') === 'DIV') {
							if (_.contains(element.attr('data-mm-role').split(' '), value)) {
								element.show();
							} else {
								element.hide();
							}
						}
					});
				});
				setState('done');
			},
			publishProgress = function (progress) {
				self.find('[data-mm-role=publish-progress-message]').text(progress);
			},
			getExportMetadata = function () {
				var form = self.find('form[data-mm-role~=export-parameters]'),
					meta = {};
				if (form) {
					form.find('button.active').add(form.find('select')).add(form.find('input')).each(function () {
						meta[jQuery(this).attr('name')] = jQuery(this).val() || jQuery(this).attr('placeholder');
					});
				}
				return meta;
			},
			exportFailed = function (reason, fileId) {
				self.find('[data-mm-role=contact-email]').attr('href', function () {
					return 'mailto:' + jQuery(this).text() + '?subject=MindMup%20' + selectedFormat().toUpperCase() + '%20Export%20Error%20' + fileId;
				});
				self.find('[data-mm-role=file-id]').html(fileId);
				self.find('.error span').hide();
				setState('error');

				var predefinedMsg = self.find('[data-mm-role=' + reason + ']');
				if (predefinedMsg.length > 0) {
					predefinedMsg.show();
				} else {
					self.find('[data-mm-role=error-message]').html(reason).show();
				}
			},
			doExport = function () {
				setState('inprogress');
				layoutExportController.startExport(selectedFormat(), {'export': getExportMetadata()}).then(publishResult, exportFailed, publishProgress);
			};
		self.find('form').submit(function () {
			return false;
		});
		confirmElement.click(doExport).keydown('space', doExport);
		self.modal({keyboard: true, show: false, backdrop: 'static'});
		self.find('[data-mm-role=set-state]').click(function () {
			setState(jQuery(this).attr('data-mm-state'));
		});
		self.on('show', function (evt) {
			if (this === evt.target) {
				setState('initial');
			}
		});
	});
};
MM.buildMapLayoutExporter = function (mapModel, resourceTranslator) {
	'use strict';
	return function () {
		var layout = mapModel.getCurrentLayout();
		if (layout && layout.nodes) {
			_.each(layout.nodes, function (node) {
				if (node.attr && node.attr.icon && node.attr.icon.url) {
					node.attr.icon.url = resourceTranslator(node.attr.icon.url);
				}
			});
		}
		return layout;
	};
};
MM.ajaxResultProcessor = function (exportConfig) {
	'use strict';
	var result = jQuery.Deferred();
	jQuery.ajax({url: exportConfig['output-url'], dataType: 'json'}).then(
			function (jsonContent) {
				result.resolve(_.extend({}, exportConfig, jsonContent));
			},
			function () {
				result.reject('generation-error');
			}
	);
	return result.promise();
};

MM.layoutExportDecorators = {};
MM.layoutExportDecorators.twitterIntentResultDecorator = function (exportResult) {
	'use strict';
	exportResult['twitter-url'] =  'https://twitter.com/intent/tweet?text=' + encodeURIComponent(exportResult.export.title) +
		'&url=' + encodeURIComponent(exportResult['index-html']) +
		'&source=mindmup.com&related=mindmup&via=mindmup';
};
MM.layoutExportDecorators.facebookResultDecorator = function (exportResult) {
	'use strict';
	exportResult['facebook-url'] = 'https://www.facebook.com/dialog/share_open_graph?' +
		'app_id=621299297886954' +
		'&display=popup' +
		'&action_type=og.likes' +
		'&action_properties=%7B%22object%22%3A%22' + encodeURIComponent(exportResult['index-html']) + '%22%7D' +
		'&redirect_uri=' + encodeURIComponent('http://www.mindmup.com/fb');
};
MM.layoutExportDecorators.googlePlusResultDecorator = function (exportResult) {
	'use strict';
	exportResult['google-plus-url'] = 'https://plus.google.com/share?url=' + encodeURIComponent(exportResult['index-html']);
};
MM.layoutExportDecorators.linkedinResultDecorator = function (exportResult) {
	'use strict';
	exportResult['linkedin-url'] = 'http://www.linkedin.com/shareArticle?mini=true' +
		'&url=' + encodeURIComponent(exportResult['index-html']) +
		'&title=' + encodeURIComponent(exportResult.export.title) +
		'&summary=' + encodeURIComponent(exportResult.export.description) +
		'&source=MindMup';

};
MM.layoutExportDecorators.tumblrResultDecorator = function (exportResult) {
	'use strict';
	exportResult['tumblr-url'] = 'http://www.tumblr.com/share/link?url=' + encodeURIComponent(exportResult['index-html']) +
		'&name=' + encodeURIComponent(exportResult.export.title) +
		'&description=' + encodeURIComponent(exportResult.export.description);
};
MM.layoutExportDecorators.pinterestResultDecorator = function (exportResult) {
	'use strict';
	exportResult['pinterest-url'] = 'https://pinterest.com/pin/create/button/?media=' + encodeURIComponent(exportResult['thumb-png']) + '&url=' + encodeURIComponent(exportResult['index-html']) + '&is_video=false&description=' + encodeURIComponent(exportResult.export.description);
};
MM.layoutExportDecorators.embedResultDecorator = function (exportResult) {
	'use strict';
	exportResult['embed-markup'] = '<iframe src="' + exportResult['index-html'] + '"></iframe>';
};

MM.layoutExportDecorators.gmailResultDecorator = function (exportResult) {
	'use strict';
	exportResult['gmail-index-html'] = 'https://mail.google.com/mail/u/0/?view=cm&ui=2&cmid=0&fs=1&tf=1&body=' + encodeURIComponent(exportResult.export.title + '\n\n') + encodeURIComponent(exportResult['index-html']);
};

MM.layoutExportDecorators.emailResultDecorator = function (exportResult) {
	'use strict';
	exportResult['email-index-html'] = 'mailto:?subject=' + encodeURIComponent(exportResult.export.title) + '&body=' + encodeURIComponent(exportResult.export.description + ':\r\n\r\n') + encodeURIComponent(exportResult['index-html']);
};

MM.layoutExportDecorators.gmailZipResultDecorator = function (exportResult) {
	'use strict';
	exportResult['gmail-archive-zip'] = 'https://mail.google.com/mail/u/0/?view=cm&ui=2&cmid=0&fs=1&tf=1&body=' + encodeURIComponent(exportResult.export.title + '\n\n') + encodeURIComponent(exportResult['archive-zip']);
};
MM.layoutExportDecorators.emailZipResultDecorator = function (exportResult) {
	'use strict';
	exportResult['email-archive-zip'] = 'mailto:?subject=' + encodeURIComponent(exportResult.export.title) + '&body=' + encodeURIComponent(exportResult.export.description + ':\r\n\r\n') + encodeURIComponent(exportResult['archive-zip']);
};
MM.sendExportDecorators = {};
MM.sendExportDecorators.emailOutputUrlDecorator = function (exportResult) {
	'use strict';
	exportResult['email-output-url'] = 'mailto:?&body=' + encodeURIComponent(exportResult['output-url'] + '\n\nThe link will be valid for 24 hours');
};
MM.sendExportDecorators.gmailOutputUrlResultDecorator = function (exportResult) {
	'use strict';
	exportResult['gmail-output-url'] = 'https://mail.google.com/mail/u/0/?view=cm&ui=2&cmid=0&fs=1&tf=1&body=' + encodeURIComponent(exportResult['output-url'] + '\n\n the link will be valid for 24 hours');
};
MM.buildDecoratedResultProcessor = function (resultProcessor, decorators) {
	'use strict';
	return function (exportConfig) {
		var deferred = jQuery.Deferred();
		resultProcessor(exportConfig).then(function (result) {
			_.each(decorators, function (decorator) {
				decorator(result);
			});
			deferred.resolve(result);
		},
		deferred.reject);
		return deferred.promise();
	};
};
