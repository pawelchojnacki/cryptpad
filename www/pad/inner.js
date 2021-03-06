require(['/api/config'], function (ApiConfig) {
    // see ckeditor_base.js getUrl()
    window.CKEDITOR_GETURL = function (resource) {
        if (resource.indexOf( '/' ) === 0) {
            resource = window.CKEDITOR.basePath.replace(/\/bower_components\/.*/, '') + resource;
        } else if (resource.indexOf(':/') === -1) {
            resource = window.CKEDITOR.basePath + resource;
        }
        if (resource[resource.length - 1] !== '/' && resource.indexOf('ver=') === -1) {
            var args = ApiConfig.requireConf.urlArgs;
            if (resource.indexOf('/bower_components/') !== -1) {
                args = 'ver=' + window.CKEDITOR.timestamp;
            }
            resource += (resource.indexOf('?') >= 0 ? '&' : '?') + args;
        }
        return resource;
    };
    require(['/bower_components/ckeditor/ckeditor.js']);
});
define([
    'jquery',
    '/bower_components/chainpad-crypto/crypto.js',
    '/bower_components/hyperjson/hyperjson.js',
    '/common/toolbar3.js',
    '/common/cursor.js',
    '/bower_components/chainpad-json-validator/json-ot.js',
    '/common/TypingTests.js',
    'json.sortify',
    '/bower_components/textpatcher/TextPatcher.js',
    '/common/cryptpad-common.js',
    '/common/cryptget.js',
    '/pad/links.js',
    '/bower_components/nthen/index.js',
    '/common/sframe-common.js',
    '/common/media-tag.js',
    '/api/config',

    '/bower_components/file-saver/FileSaver.min.js',
    '/bower_components/diff-dom/diffDOM.js',

    'css!/bower_components/bootstrap/dist/css/bootstrap.min.css',
    'less!/bower_components/components-font-awesome/css/font-awesome.min.css',
    'less!/customize/src/less2/main.less',
], function (
    $,
    Crypto,
    Hyperjson,
    Toolbar,
    Cursor,
    JsonOT,
    TypingTest,
    JSONSortify,
    TextPatcher,
    Cryptpad,
    Cryptget,
    Links,
    nThen,
    SFCommon,
    MediaTag,
    ApiConfig)
{
    var saveAs = window.saveAs;
    var Messages = Cryptpad.Messages;
    var DiffDom = window.diffDOM;

    var stringify = function (obj) { return JSONSortify(obj); };

    window.Toolbar = Toolbar;
    window.Hyperjson = Hyperjson;

    var slice = function (coll) {
        return Array.prototype.slice.call(coll);
    };

    var removeListeners = function (root) {
        slice(root.attributes).map(function (attr) {
            if (/^on/.test(attr.name)) {
                root.attributes.removeNamedItem(attr.name);
            }
        });
        slice(root.children).forEach(removeListeners);
    };

    var hjsonToDom = function (H) {
        var dom = Hyperjson.toDOM(H);
        removeListeners(dom);
        return dom;
    };

    var module = window.REALTIME_MODULE = window.APP = {
        Hyperjson: Hyperjson,
        TextPatcher: TextPatcher,
        logFights: true,
        fights: [],
        Cryptpad: Cryptpad,
        Cursor: Cursor,
    };

    var emitResize = module.emitResize = function () {
        var evt = window.document.createEvent('UIEvents');
        evt.initUIEvent('resize', true, false, window, 0);
        window.dispatchEvent(evt);
    };

    var toolbar;

    var isNotMagicLine = function (el) {
        return !(el && typeof(el.getAttribute) === 'function' &&
            el.getAttribute('class') &&
            el.getAttribute('class').split(' ').indexOf('non-realtime') !== -1);
    };

    /* catch `type="_moz"` before it goes over the wire */
    var brFilter = function (hj) {
        if (hj[1].type === '_moz') { hj[1].type = undefined; }
        return hj;
    };
    var mediatagContentFilter = function (hj) {
        if (hj[0] === 'MEDIA-TAG') { hj[2] = []; }
        return hj;
    };
    var hjsonFilters = function (hj) {
        brFilter(hj);
        mediatagContentFilter(hj);
        return hj;
    };

    var onConnectError = function () {
        Cryptpad.errorLoadingScreen(Messages.websocketError);
    };

    var domFromHTML = function (html) {
        return new DOMParser().parseFromString(html, 'text/html');
    };

    var forbiddenTags = [
        'SCRIPT',
        //'IFRAME',
        'OBJECT',
        'APPLET',
        //'VIDEO',
        //'AUDIO'
    ];

    var getHTML = function (inner) {
        return ('<!DOCTYPE html>\n' + '<html>\n' + inner.innerHTML);
    };

    var CKEDITOR_CHECK_INTERVAL = 100;
    var ckEditorAvailable = function (cb) {
        var intr;
        var check = function () {
            if (window.CKEDITOR) {
                clearTimeout(intr);
                cb(window.CKEDITOR);
            }
        };
        intr = setInterval(function () {
            console.log("Ckeditor was not defined. Trying again in %sms", CKEDITOR_CHECK_INTERVAL);
            check();
        }, CKEDITOR_CHECK_INTERVAL);
        check();
    };

    var mkDiffOptions = function (cursor, readOnly) {
        return {
            preDiffApply: function (info) {
                /*
                    Don't accept attributes that begin with 'on'
                    these are probably listeners, and we don't want to
                    send scripts over the wire.
                */
                if (['addAttribute', 'modifyAttribute'].indexOf(info.diff.action) !== -1) {
                    if (info.diff.name === 'href') {
                        // console.log(info.diff);
                        //var href = info.diff.newValue;

                        // TODO normalize HTML entities
                        if (/javascript *: */.test(info.diff.newValue)) {
                            // TODO remove javascript: links
                        }
                    }

                    if (/^on/.test(info.diff.name)) {
                        console.log("Rejecting forbidden element attribute with name (%s)", info.diff.name);
                        return true;
                    }
                }
                /*
                    Also reject any elements which would insert any one of
                    our forbidden tag types: script, iframe, object,
                        applet, video, or audio
                */
                if (['addElement', 'replaceElement'].indexOf(info.diff.action) !== -1) {
                    if (info.diff.element && forbiddenTags.indexOf(info.diff.element.nodeName) !== -1) {
                        console.log("Rejecting forbidden tag of type (%s)", info.diff.element.nodeName);
                        return true;
                    } else if (info.diff.newValue && forbiddenTags.indexOf(info.diff.newValue.nodeType) !== -1) {
                        console.log("Rejecting forbidden tag of type (%s)", info.diff.newValue.nodeName);
                        return true;
                    }
                }

                if (info.node && info.node.tagName === 'BODY') {
                    if (info.diff.action === 'removeAttribute' &&
                        ['class', 'spellcheck'].indexOf(info.diff.name) !== -1) {
                        return true;
                    }
                }

                /* DiffDOM will filter out magicline plugin elements
                    in practice this will make it impossible to use it
                    while someone else is typing, which could be annoying.

                    we should check when such an element is going to be
                    removed, and prevent that from happening. */
                if (info.node && info.node.tagName === 'SPAN' &&
                    info.node.getAttribute('contentEditable') === "false") {
                    // it seems to be a magicline plugin element...
                    if (info.diff.action === 'removeElement') {
                        // and you're about to remove it...
                        // this probably isn't what you want

                        /*
                            I have never seen this in the console, but the
                            magic line is still getting removed on remote
                            edits. This suggests that it's getting removed
                            by something other than diffDom.
                        */
                        console.log("preventing removal of the magic line!");

                        // return true to prevent diff application
                        return true;
                    }
                }

                // Do not change the contenteditable value in view mode
                if (readOnly && info.node && info.node.tagName === 'BODY' &&
                    info.diff.action === 'modifyAttribute' && info.diff.name === 'contenteditable') {
                    return true;
                }

                // no use trying to recover the cursor if it doesn't exist
                if (!cursor.exists()) { return; }

                /*  frame is either 0, 1, 2, or 3, depending on which
                    cursor frames were affected: none, first, last, or both
                */
                var frame = info.frame = cursor.inNode(info.node);

                if (!frame) { return; }

                if (typeof info.diff.oldValue === 'string' && typeof info.diff.newValue === 'string') {
                    var pushes = cursor.pushDelta(info.diff.oldValue, info.diff.newValue);

                    if (frame & 1) {
                        // push cursor start if necessary
                        if (pushes.commonStart < cursor.Range.start.offset) {
                            cursor.Range.start.offset += pushes.delta;
                        }
                    }
                    if (frame & 2) {
                        // push cursor end if necessary
                        if (pushes.commonStart < cursor.Range.end.offset) {
                            cursor.Range.end.offset += pushes.delta;
                        }
                    }
                }
            },
            postDiffApply: function (info) {
                if (info.frame) {
                    if (info.node) {
                        if (info.frame & 1) { cursor.fixStart(info.node); }
                        if (info.frame & 2) { cursor.fixEnd(info.node); }
                    } else { console.error("info.node did not exist"); }

                    var sel = cursor.makeSelection();
                    var range = cursor.makeRange();

                    cursor.fixSelection(sel, range);
                }
            }
        };
    };

    ////////////////////////////////////////////////////////////////////////////////////////////////////////////
    ////////////////////////////////////////////////////////////////////////////////////////////////////////////
    ////////////////////////////////////////////////////////////////////////////////////////////////////////////
    ////////////////////////////////////////////////////////////////////////////////////////////////////////////
    ////////////////////////////////////////////////////////////////////////////////////////////////////////////

    var andThen = function (editor, Ckeditor, common) {
        //var $iframe = $('#pad-iframe').contents();
        //var secret = Cryptpad.getSecrets();
        //var readOnly = secret.keys && !secret.keys.editKeyStr;
        //if (!secret.keys) {
        //    secret.keys = secret.key;
        //}
        var readOnly = false; // TODO
        var cpNfInner;
        var metadataMgr;
        var onLocal;

        var $bar = $('#cke_1_toolbox');

        var $html = $bar.closest('html');
        var $faLink = $html.find('head link[href*="/bower_components/components-font-awesome/css/font-awesome.min.css"]');
        if ($faLink.length) {
            $html.find('iframe').contents().find('head').append($faLink.clone());
        }
        var isHistoryMode = false;

        if (readOnly) {
            $('#cke_1_toolbox > .cke_toolbox_main').hide();
        }

        /* add a class to the magicline plugin so we can pick it out more easily */

        var ml = Ckeditor.instances.editor1.plugins.magicline.backdoor.that.line.$;
        [ml, ml.parentElement].forEach(function (el) {
            el.setAttribute('class', 'non-realtime');
        });

        var ifrWindow = $html.find('iframe')[0].contentWindow;

        var documentBody = ifrWindow.document.body;

        var inner = window.inner = documentBody;

        var cursor = module.cursor = Cursor(inner);

        var openLink = function (e) {
            var el = e.currentTarget;
            if (!el || el.nodeName !== 'A') { return; }
            var href = el.getAttribute('href');
            var bounceHref = window.location.origin + '/bounce/#' + encodeURIComponent(href);
            if (href) { ifrWindow.open(bounceHref, '_blank'); }
        };

        var setEditable = module.setEditable = function (bool) {
            if (bool) {
                $(inner).css({
                    color: '#333',
                });
            }
            if (!readOnly || !bool) {
                inner.setAttribute('contenteditable', bool);
            }
        };

        // don't let the user edit until the pad is ready
        setEditable(false);

        var initializing = true;

        var Title;
        //var UserList;
        //var Metadata;

        var getHeadingText = function () {
            var text;
            if (['h1', 'h2', 'h3'].some(function (t) {
                var $header = $(inner).find(t + ':first-of-type');
                if ($header.length && $header.text()) {
                    text = $header.text();
                    return true;
                }
            })) { return text; }
        };

        var DD = new DiffDom(mkDiffOptions(cursor, readOnly));

        var mediaMap = {};
        var restoreMediaTags = function (tempDom) {
            var tags = tempDom.querySelectorAll('media-tag:empty');
            Cryptpad.slice(tags).forEach(function (tag) {
                var src = tag.getAttribute('src');
                if (mediaMap[src]) {
                    mediaMap[src].forEach(function (n) {
                        tag.appendChild(n);
                    });
                }
            });
        };
        var displayMediaTags = function (dom) {
            setTimeout(function () { // Just in case
                var tags = dom.querySelectorAll('media-tag:empty');
                Cryptpad.slice(tags).forEach(function (el) {
                    MediaTag(el);
                    $(el).on('keydown', function (e) {
                        if ([8,46].indexOf(e.which) !== -1) {
                            $(el).remove();
                            onLocal();
                        }
                    });
                    var observer = new MutationObserver(function(mutations) {
                        mutations.forEach(function(mutation) {
                            if (mutation.type === 'childList') {
                                var list_values = [].slice.call(el.children);
                                mediaMap[el.getAttribute('src')] = list_values;
                            }
                        });
                    });
                    observer.observe(el, {
                        attributes: false,
                        childList: true,
                        characterData: false
                    });
                });
            });
        };

        // apply patches, and try not to lose the cursor in the process!
        var applyHjson = function (shjson) {
            var userDocStateDom = hjsonToDom(JSON.parse(shjson));

            if (!readOnly && !initializing) {
                userDocStateDom.setAttribute("contenteditable", "true"); // lol wtf
            } else if (readOnly) {
                userDocStateDom.removeAttribute("contenteditable");
            }
            restoreMediaTags(userDocStateDom);
            var patch = (DD).diff(inner, userDocStateDom);
            (DD).apply(inner, patch);
            displayMediaTags(inner);
            if (readOnly) {
                var $links = $(inner).find('a');
                // off so that we don't end up with multiple identical handlers
                $links.off('click', openLink).on('click', openLink);
            }
        };

        var stringifyDOM = module.stringifyDOM = function (dom) {
            var hjson = Hyperjson.fromDOM(dom, isNotMagicLine, hjsonFilters);
            hjson[3] = {
                metadata: metadataMgr.getMetadataLazy()
            };
            /*hjson[3] = { TODO
                    users: UserList.userData,
                    defaultTitle: Title.defaultTitle,
                    type: 'pad'
                }
            };
            if (!initializing) {
                hjson[3].metadata.title = Title.title;
            } else if (Cryptpad.initialName && !hjson[3].metadata.title) {
                hjson[3].metadata.title = Cryptpad.initialName;
            }*/
            return stringify(hjson);
        };

        var realtimeOptions = {
            readOnly: readOnly,
            // really basic operational transform
            transformFunction : JsonOT.validate,
            // cryptpad debug logging (default is 1)
            // logLevel: 0,
            validateContent: function (content) {
                try {
                    JSON.parse(content);
                    return true;
                } catch (e) {
                    console.log("Failed to parse, rejecting patch");
                    return false;
                }
            }
        };

        var setHistory = function (bool, update) {
            isHistoryMode = bool;
            setEditable(!bool);
            if (!bool && update) {
                realtimeOptions.onRemote();
            }
        };

        realtimeOptions.onRemote = function () {
            if (initializing) { return; }
            if (isHistoryMode) { return; }

            var oldShjson = stringifyDOM(inner);

            var shjson = module.realtime.getUserDoc();

            // remember where the cursor is
            cursor.update();

            // Update the user list (metadata) from the hyperjson
            // TODO Metadata.update(shjson);

            var newInner = JSON.parse(shjson);
            var newSInner;
            if (newInner.length > 2) {
                newSInner = stringify(newInner[2]);
            }

            if (newInner[3]) {
                metadataMgr.updateMetadata(newInner[3].metadata);
            }

            // build a dom from HJSON, diff, and patch the editor
            applyHjson(shjson);

            if (!readOnly) {
                var shjson2 = stringifyDOM(inner);

                // TODO
                //shjson = JSON.stringify(JSON.parse(shjson).slice(0,3));

                if (shjson2 !== shjson) {
                    console.error("shjson2 !== shjson");
                    module.patchText(shjson2);

                    /*  pushing back over the wire is necessary, but it can
                        result in a feedback loop, which we call a browser
                        fight */
                    if (module.logFights) {
                        // what changed?
                        var op = TextPatcher.diff(shjson, shjson2);
                        // log the changes
                        TextPatcher.log(shjson, op);
                        var sop = JSON.stringify(TextPatcher.format(shjson, op));

                        var index = module.fights.indexOf(sop);
                        if (index === -1) {
                            module.fights.push(sop);
                            console.log("Found a new type of browser disagreement");
                            console.log("You can inspect the list in your " +
                                "console at `REALTIME_MODULE.fights`");
                            console.log(module.fights);
                        } else {
                            console.log("Encountered a known browser disagreement: " +
                                "available at `REALTIME_MODULE.fights[%s]`", index);
                        }
                    }
                }
            }

            // Notify only when the content has changed, not when someone has joined/left
            var oldSInner = stringify(JSON.parse(oldShjson)[2]);
            if (newSInner && newSInner !== oldSInner) {
                common.notify();
            }
        };

        var exportFile = function () {
            var html = getHTML(inner);
            var suggestion = Title.suggestTitle('cryptpad-document');
            Cryptpad.prompt(Messages.exportPrompt,
                Cryptpad.fixFileName(suggestion) + '.html', function (filename) {
                if (!(typeof(filename) === 'string' && filename)) { return; }
                var blob = new Blob([html], {type: "text/html;charset=utf-8"});
                saveAs(blob, filename);
            });
        };
        var importFile = function (content) {
            var shjson = stringify(Hyperjson.fromDOM(domFromHTML(content).body));
            applyHjson(shjson);
            realtimeOptions.onLocal();
        };

        realtimeOptions.onInit = function (info) {
            readOnly = metadataMgr.getPrivateData().readOnly;
            var titleCfg = { getHeadingText: getHeadingText };
            Title = common.createTitle(titleCfg, realtimeOptions.onLocal);
            var configTb = {
                displayed: ['userlist', 'title', 'useradmin', 'spinner', 'newpad', 'share', 'limit'],
                title: Title.getTitleConfig(),
                metadataMgr: metadataMgr,
                readOnly: readOnly,
                ifrw: window,
                realtime: info.realtime,
                common: Cryptpad,
                sfCommon: common,
                $container: $bar,
                $contentContainer: $('#cke_1_contents'),
            };
            toolbar = info.realtime.toolbar = Toolbar.create(configTb);
            Title.setToolbar(toolbar);

            var $rightside = toolbar.$rightside;
            var $drawer = toolbar.$drawer;

            var src = 'less!/customize/src/less/toolbar.less';
            require([
                src
            ], function () {
                var $html = $bar.closest('html');
                $html
                    .find('head style[data-original-src="' + src.replace(/less!/, '') + '"]')
                    .appendTo($html.find('head'));
            });

            $bar.find('#cke_1_toolbar_collapser').hide();
            if (!readOnly) {
                // Expand / collapse the toolbar
                var $collapse = common.createButton(null, true);
                $collapse.removeClass('fa-question');
                var updateIcon = function (isVisible) {
                    $collapse.removeClass('fa-caret-down').removeClass('fa-caret-up');
                    if (!isVisible) {
                        if (!initializing) { common.feedback('HIDETOOLBAR_PAD'); }
                        $collapse.addClass('fa-caret-down');
                    }
                    else {
                        if (!initializing) { common.feedback('SHOWTOOLBAR_PAD'); }
                        $collapse.addClass('fa-caret-up');
                    }
                };
                updateIcon();
                $collapse.click(function () {
                    $(window).trigger('resize');
                    $('.cke_toolbox_main').toggle();
                    $(window).trigger('cryptpad-ck-toolbar');
                    var isVisible = $bar.find('.cke_toolbox_main').is(':visible');
                    common.setAttribute(['pad', 'showToolbar'], isVisible);
                    updateIcon(isVisible);
                });
                common.getAttribute(['pad', 'showToolbar'], function (err, data) {
                    if (typeof(data) === "undefined" || data) {
                        $('.cke_toolbox_main').show();
                        updateIcon(true);
                        return;
                    }
                    $('.cke_toolbox_main').hide();
                    updateIcon(false);
                });
                $rightside.append($collapse);
            } else {
                $('.cke_toolbox_main').hide();
            }

            /* add a history button */
            var histConfig = {
                onLocal: realtimeOptions.onLocal,
                onRemote: realtimeOptions.onRemote,
                setHistory: setHistory,
                applyVal: function (val) { applyHjson(val || '["BODY",{},[]]'); },
                $toolbar: $bar
            };
            var $hist = common.createButton('history', true, {histConfig: histConfig});
            $drawer.append($hist);

            if (!metadataMgr.getPrivateData().isTemplate) {
                var templateObj = {
                    rt: info.realtime,
                    getTitle: function () { return metadataMgr.getMetadata().title; }
                };
                var $templateButton = common.createButton('template', true, templateObj);
                $rightside.append($templateButton);
            }

            /* add an export button */
            var $export = common.createButton('export', true, {}, exportFile);
            $drawer.append($export);

            if (!readOnly) {
                /* add an import button */
                var $import = common.createButton('import', true, {
                    accept: 'text/html'
                }, importFile);
                $drawer.append($import);
            }

            /* add a forget button */
            var forgetCb = function (err) {
                if (err) { return; }
                setEditable(false);
            };
            var $forgetPad = common.createButton('forget', true, {}, forgetCb);
            $rightside.append($forgetPad);

            if (!readOnly) {
                var fileDialogCfg = {
                    onSelect: function (data) {
                        if (data.type === 'file') {
                            var mt = '<media-tag contenteditable="false" src="' + data.src + '" data-crypto-key="cryptpad:' + data.key + '" tabindex="1"></media-tag>';
                            editor.insertElement(window.CKEDITOR.dom.element.createFromHtml(mt));
                            return;
                        }
                    }
                };
                common.initFilePicker(fileDialogCfg);
                window.APP.$mediaTagButton = $('<button>', {
                    title: Messages.filePickerButton,
                    'class': 'cp-toolbar-rightside-button fa fa-picture-o',
                    style: 'font-size: 17px'
                }).click(function () {
                    var pickerCfg = {
                        types: ['file'],
                        where: ['root']
                    };
                    common.openFilePicker(pickerCfg);
                }).appendTo($rightside);


                var $tags = common.createButton('hashtag', true);
                $rightside.append($tags);
            }
        };

        // this should only ever get called once, when the chain syncs
        realtimeOptions.onReady = function (info) {
            if (!module.isMaximized) {
                module.isMaximized = true;
                $('iframe.cke_wysiwyg_frame').css('width', '');
                $('iframe.cke_wysiwyg_frame').css('height', '');
            }
            $('body').addClass('app-pad');

            if (module.realtime !== info.realtime) {
                module.patchText = TextPatcher.create({
                    realtime: info.realtime,
                    //logging: true,
                });
            }

            module.realtime = info.realtime;

            var shjson = module.realtime.getUserDoc();

            var newPad = false;
            if (shjson === '') { newPad = true; }

            if (!newPad) {
                if (shjson[0] !== '[') {
                    var errorText = Messages.typeError;
                    Cryptpad.errorLoadingScreen(errorText);
                    throw new Error(errorText);
                }
                applyHjson(shjson);

                var parsed = JSON.parse(shjson);
                if (parsed[3] && parsed[3].metadata) {
                    metadataMgr.updateMetadata(parsed[3].metadata);
                }

                if (!readOnly) {
                    var shjson2 = stringifyDOM(inner);
                    var hjson2 = JSON.parse(shjson2).slice(0,3);
                    var hjson = JSON.parse(shjson).slice(0,3);
                    if (stringify(hjson2) !== stringify(hjson)) {
                        console.log('err');
                        console.error("shjson2 !== shjson");
                        console.log(stringify(hjson2));
                        console.log(stringify(hjson));
                        Cryptpad.errorLoadingScreen(Messages.wrongApp);
                        throw new Error();
                    }
                }
            } else {
                Title.updateTitle(Cryptpad.initialName || Title.defaultTitle);
                documentBody.innerHTML = Messages.initialState;
            }

            Cryptpad.removeLoadingScreen(emitResize);
            setEditable(!readOnly);
            initializing = false;

            if (readOnly) { return; }


            if (newPad) {
                common.openTemplatePicker();
            }

            onLocal();

            var fmConfig = {
                ckeditor: editor,
                body: $('body'),
                onUploaded: function (ev, data) {
                    var parsed = Cryptpad.parsePadUrl(data.url);
                    var hexFileName = Cryptpad.base64ToHex(parsed.hashData.channel);
                    var src = '/blob/' + hexFileName.slice(0,2) + '/' + hexFileName;
                    var mt = '<media-tag contenteditable="false" src="' + src + '" data-crypto-key="cryptpad:' + parsed.hashData.key + '" tabindex="1"></media-tag>';
                    editor.insertElement(window.CKEDITOR.dom.element.createFromHtml(mt));
                }
            };
            window.APP.FM = common.createFileManager(fmConfig);

            editor.focus();
            if (newPad) {
                cursor.setToEnd();
            } else {
                cursor.setToStart();
            }
        };

        realtimeOptions.onConnectionChange = function (info) {
            setEditable(info.state);
            if (info.state) {
                initializing = true;
                Cryptpad.findOKButton().click();
            } else {
                Cryptpad.alert(Messages.common_connectionLost, undefined, true);
            }
        };

        realtimeOptions.onError = onConnectError;

        onLocal = realtimeOptions.onLocal = function () {
            console.log('onlocal');
            if (initializing) { return; }
            if (isHistoryMode) { return; }
            if (readOnly) { return; }

            // stringify the json and send it into chainpad
            var shjson = stringifyDOM(inner);
            displayMediaTags(inner);

            module.patchText(shjson);
            if (module.realtime.getUserDoc() !== shjson) {
                console.error("realtime.getUserDoc() !== shjson");
            }
        };

        cpNfInner = common.startRealtime(realtimeOptions);
        metadataMgr = cpNfInner.metadataMgr;

        cpNfInner.onInfiniteSpinner(function () {
            setEditable(false);
            Cryptpad.confirm(Messages.realtime_unrecoverableError, function (yes) {
                if (!yes) { return; }
                common.gotoURL();
                //window.parent.location.reload();
            });
        });

        Cryptpad.onLogout(function () { setEditable(false); });

        /* hitting enter makes a new line, but places the cursor inside
            of the <br> instead of the <p>. This makes it such that you
            cannot type until you click, which is rather unnacceptable.
            If the cursor is ever inside such a <br>, you probably want
            to push it out to the parent element, which ought to be a
            paragraph tag. This needs to be done on keydown, otherwise
            the first such keypress will not be inserted into the P. */
        inner.addEventListener('keydown', cursor.brFix);

        editor.on('change', onLocal);

        // export the typing tests to the window.
        // call like `test = easyTest()`
        // terminate the test like `test.cancel()`
        window.easyTest = function () {
            cursor.update();
            var start = cursor.Range.start;
            var test = TypingTest.testInput(inner, start.el, start.offset, onLocal);
            onLocal();
            return test;
        };

        $bar.find('.cke_button').click(function () {
            var e = this;
            var classString = e.getAttribute('class');
            var classes = classString.split(' ').filter(function (c) {
                return /cke_button__/.test(c);
            });

            var id = classes[0];
            if (typeof(id) === 'string') {
                common.feedback(id.toUpperCase());
            }
        });
    };

    var main = function () {
        var Ckeditor;
        var editor;
        var common;

        nThen(function (waitFor) {
            ckEditorAvailable(waitFor(function (ck) {
                Ckeditor = ck;
                require(['/pad/wysiwygarea-plugin.js'], waitFor());
            }));
            $(waitFor(function () {
                Cryptpad.addLoadingScreen();
            }));
            SFCommon.create(waitFor(function (c) { module.common = common = c; }));
        }).nThen(function (waitFor) {
            Ckeditor.config.toolbarCanCollapse = true;
            if (screen.height < 800) {
                Ckeditor.config.toolbarStartupExpanded = false;
                $('meta[name=viewport]').attr('content', 'width=device-width, initial-scale=1.0, user-scalable=no');
            } else {
                $('meta[name=viewport]').attr('content', 'width=device-width, initial-scale=1.0, user-scalable=yes');
            }
            // Used in ckeditor-config.js
            Ckeditor.CRYPTPAD_URLARGS = ApiConfig.requireConf.urlArgs;
            Ckeditor.plugins.addExternal('mediatag','/pad/', 'mediatag-plugin.js');
            module.ckeditor = editor = Ckeditor.replace('editor1', {
                customConfig: '/customize/ckeditor-config.js',
            });
            editor.on('instanceReady', waitFor());
        }).nThen(function (/*waitFor*/) {
            editor.plugins.mediatag.translations = {
                title: Messages.pad_mediatagTitle,
                width: Messages.pad_mediatagWidth,
                height: Messages.pad_mediatagHeight
            };
            /*if (Ckeditor.env.safari) {
                var fixIframe = function () {
                    $('iframe.cke_wysiwyg_frame').height($('#cke_1_contents').height());
                };
                $(window).resize(fixIframe);
                fixIframe();
            }*/
            Links.addSupportForOpeningLinksInNewTab(Ckeditor)({editor: editor});
            Cryptpad.onError(function (info) {
                if (info && info.type === "store") {
                    onConnectError();
                }
            });
            andThen(editor, Ckeditor, common);
        });
    };
    main();
});
