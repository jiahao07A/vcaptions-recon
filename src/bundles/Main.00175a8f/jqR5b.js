/* parcel module id: jqR5b | bundle: Main.00175a8f.js | bytes: 787 | separator-after: "," */
Y.register("jqR5b",function(e,t){var I;e.exports=(I=Y("kIsEi"),Y("9KglG"),/** @preserve
	 * Counter block mode compatible with  Dr Brian Gladman fileenc.c
	 * derived from CryptoJS.mode.CTR
	 * Jan Hruby jhruby.web@gmail.com
	 */I.mode.CTRGladman=function(){var e=I.lib.BlockCipherMode.extend();function t(e){if((e>>24&255)==255){var t=e>>16&255,I=e>>8&255,l=255&e;255===t?(t=0,255===I?(I=0,255===l?l=0:++l):++I):++t,e=0+(t<<16)+(I<<8)+l}else e+=16777216;return e}var l=e.Encryptor=e.extend({processBlock:function(e,I){var l,n=this._cipher,a=n.blockSize,r=this._iv,i=this._counter;r&&(i=this._counter=r.slice(0),this._iv=void 0),0===((l=i)[0]=t(l[0]))&&(l[1]=t(l[1]));var c=i.slice(0);n.encryptBlock(c,0);for(var s=0;s<a;s++)e[I+s]^=c[s]}});return e.Decryptor=l,e}(),I.mode.CTRGladman)})